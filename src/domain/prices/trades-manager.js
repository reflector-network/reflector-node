const {normalizeTimestamp, Asset, AssetType, ContractTypes, hasMajority, compareStrings} = require('@reflector/reflector-shared')
const dataSourcesManager = require('../data-sources-manager')
const logger = require('../../logger')
const container = require('../container')
const {getAllSubscriptions} = require('../subscriptions/subscriptions-data-manager')
const nodesManager = require('../nodes/nodes-manager')
const MessageTypes = require('../../ws-server/handlers/message-types')
const wsConstants = require('../../ws-server/contstants')
const {runWithContext} = require('../../async-storage')
const {withDeadline} = require('../../utils')
const {priceSyncDelay} = require('../sync-delays')
const TradesCache = require('./trades-cache')
const {getRetentionHeartbeat} = require('./trades-cache')
const AssetsMap = require('./assets-map')
const {validatePriceSyncItem, getSyncWindow, getMaxSyncTimestamps, maxSyncKeys} = require('./price-sync-validator')

//TODO: implement timestamp manager, to avoid confusion with the timestamps

const cacheSize = 15
const minute = 60 * 1000
//outer budget for one connector call. Each connector bounds a single provider request (3 tries of 10 s plus
//back-off), but not the whole call, and __loadDataForAssetMap only queues the next tick behind a pending request - so a
//promise that never settles would stop this source for good
const minPriceFetchTimeout = 90 * 1000
const priceFetchMargin = 45 * 1000
//connector calls abandoned at that budget, keyed by source and base asset, with when each started and its budget.
//withDeadline stops the wait but cannot stop the call, so under rate limiting an abandoned call and the next tick's call
//for the same key piled up. A key whose previous call has not settled is not fetched again:
//this node loses its own samples for the tick, as a failed fetch does, and still signs what the cluster majority agreed
//on. A call that never settles would block its key until a restart, so after three of its budgets it
//is given up and the key is fetched again
const unsettledConnectorCalls = new Map()
const unsettledCallBudgets = 3
//the validated ingest window admits about priceHeartbeat/1 min distinct minutes; keep two windows of slack so a
//legitimate heartbeat change can never make the read path throw
const minPendingTimestamps = 512
const defaultSyncWait = 25 * 1000
const maxTimerDelay = 2 ** 31 - 1 //Node replaces any longer delay with 1 ms
//every peer refuses a frame above wsConstants.maxPayload (1 MiB), and a reconnect backfill of one key holds every minute
//of the heartbeat window - 1 183 538 bytes for 20 assets priced by 5 exchanges at the default 2 h. PRICE_SYNC therefore
//goes out in frames of at most half the cap; a receiver merges each frame on its own, so the cut changes nothing it
//caches or computes
const maxPriceSyncFrameBytes = wsConstants.maxPayload / 2
//ChannelBase.send adds a uuid requestId to every message it sends, and it counts against the peer's cap too
const priceSyncFrameEnvelope = {type: MessageTypes.PRICE_SYNC, data: {}, requestId: '00000000-0000-0000-0000-000000000000'}

/**
 * @returns {number} upper bound on distinct timestamps held in the sync map
 */
function getMaxPendingTimestamps() {
    //getRetentionHeartbeat is always finite: a non-numeric or infinite heartbeat must not turn the bound into NaN or
    //Infinity, which no size ever reaches
    return Math.max(minPendingTimestamps, Math.ceil(getRetentionHeartbeat() / minute) * 2)
}

/**
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

/**
 * @typedef {Object} TradeData
 * @property {BigInt} volume - volume
 * @property {BigInt} quoteVolume - quote volume
 * @property {string} source - source
 */

/**
 * @typedef {TradeData[]} AssetTradeData
 * An array of trades from multiple sources for a single asset.
 */

/**
 * @typedef {AssetTradeData[]} TimestampTradeData
 * An array of asset trade data for a single timestamp.
 */

/**
 * @typedef {TimestampTradeData[]} AggregatedTradeData
 * An array of timestamped trade data for multiple assets.
 */

function getSampleSize(lastTimestemp, targetTimestamp) {
    if (lastTimestemp >= targetTimestamp) {
        return 0
    }
    const computedCount = (targetTimestamp - lastTimestemp) / minute
    return Math.min(computedCount, cacheSize)
}

/**
 * The outer budget for one connector call. The exchanges connector builds one pair per asset and walks the pairs in
 * batches of batchSize, one batch per batchDelay at best, so a healthy fetch of a large map outlasts any fixed budget;
 * the map has no cap, because every subscription asset joins it. The margin covers market loading and one slow batch
 * @param {number} pairs - number of assets requested
 * @param {number} batchSize - pairs per batch, as the node passes it to the connector
 * @param {number} batchDelay - minimum milliseconds per batch, as the node passes it to the connector
 * @returns {number} budget in milliseconds, never below 90 s
 */
function getPriceFetchTimeout(pairs, batchSize, batchDelay) {
    const batches = Math.ceil(pairs / Math.max(1, batchSize || 1))
    return Math.max(minPriceFetchTimeout, batches * (batchDelay || 0) + priceFetchMargin)
}

/**
 * @param {any} dataSource - source
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets
 * @param {number} from - from miliseconds timestamp
 * @param {number} count - count of items to load
 * @return {Promise<AggregatedTradeData>}
 */
async function loadPriceData(dataSource, baseAsset, assets, from, count) {
    const callKey = `${dataSource.name}_${baseAsset.code}`
    const unsettled = unsettledConnectorCalls.get(callKey)
    if (unsettled) {
        const heldMs = Date.now() - unsettled.startedAt
        if (heldMs < unsettledCallBudgets * unsettled.budget) {
            //expected for every tick of the hold, so it is no error: announced once per hold as a warning, followed at
            //debug, and the caller logs nothing more for it
            const skipEntry = {msg: 'Price data request skipped: the previous request for the key has not settled', key: callKey, heldMs}
            if (unsettled.announced)
                logger.debug(skipEntry)
            else {
                unsettled.announced = true
                logger.warn(skipEntry)
            }
            const skipped = new Error(`Price data request for ${dataSource.name} skipped: the previous request has not settled`)
            skipped.skipped = true
            throw skipped
        }
        logger.warn({
            msg: 'A connector call has not settled after three fetch budgets; the key is fetched again',
            key: callKey,
            startedAt: unsettled.startedAt
        })
        unsettledConnectorCalls.delete(callKey)
    }
    from = from / 1000 //convert to seconds
    const start = Date.now()
    const requestOptions = normalizePriceDataFetchOptions(dataSource, baseAsset, assets, from, minute / 1000, count)
    //the node's own batching options, not the connector's defaults, decide how long a healthy fetch takes.
    //reflector-exchanges-connector merges them over its defaults ({...defaultFetchOptions, ...options}, src/index.js
    //in 2.1.0), so its batchSize 10 / batchDelay 2000 (src/index.js:43) never apply to this node,
    //and its getPairs (src/index.js:65-72) builds exactly one pair per requested asset
    const {batchSize, batchDelay} = requestOptions.options
    const priceFetchTimeout = getPriceFetchTimeout(requestOptions.assets.length, batchSize, batchDelay)
    //an answer after the budget is discarded by withDeadline: the caller has already failed this source for the tick,
    //so nothing from it can reach the trades cache or the gossip
    let call = null
    try {
        call = Promise.resolve(dataSource.instance.getPriceData(requestOptions))
    } catch (err) {
        call = Promise.reject(err) //a connector that throws synchronously settles like any other failure
    }
    //removed only by the call that made the entry, so a given-up call that settles late leaves a newer call's entry alone
    const entry = {startedAt: Date.now(), budget: priceFetchTimeout}
    unsettledConnectorCalls.set(callKey, entry)
    const settle = () => {
        if (unsettledConnectorCalls.get(callKey) !== entry)
            return
        unsettledConnectorCalls.delete(callKey)
        //the end of a hold that was announced is logged once; a call that held no tick back settles silently
        if (entry.announced)
            logger.info({msg: 'The held connector call settled; the key is fetched again', key: callKey, heldMs: Date.now() - entry.startedAt})
    }
    call.then(settle, settle)
    const tradesData = await withDeadline(
        call,
        priceFetchTimeout,
        `Price data request for ${dataSource.name} timed out after ${priceFetchTimeout} ms`
    )
    logger.info({msg: 'Loaded trade data', count: tradesData.length, source: dataSource.name, duration: Date.now() - start})
    return tradesData
}

/**
 * Builds the options object every connector's `getPriceData` receives. `from` is the start of the requested window in
 * seconds; `reflector-fx-connector` 3.1.0 and later read that field, so no second `timestamp` alias is sent.
 * @param {{name: string, providers: string[]}} datasource - data source descriptor
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets to load
 * @param {number} from - start of the window, in seconds
 * @param {number} period - period length, in seconds
 * @param {number} count - number of periods
 * @returns {object} connector options with every undefined entry removed
 */
function normalizePriceDataFetchOptions(datasource, baseAsset, assets, from, period, count) {
    const {settingsManager} = container
    const options = {
        baseAsset: baseAsset.code,
        assets: assets.map(a => a.code),
        from,
        period,
        count,
        options: {
            batchSize: settingsManager.gateways?.urls?.length || 1,
            batchDelay: 1500,
            sources: datasource.providers,
            timeout: 15000
        },
        simSource: settingsManager.getSimSource(),
        crossAssets: ['XLM']
    }
    //remove all undefined options
    const removeUndefinedOptions = (raw) => {
        for (const key of Object.keys(raw)) {
            if (raw[key] === undefined)
                delete raw[key]
            //null is a value the connector reads (a provider entry of null means its defaults), not a nested object
            else if (raw[key] !== null && typeof raw[key] === 'object' && !Array.isArray(raw[key]))
                raw[key] = removeUndefinedOptions(raw[key])
        }
        return raw
    }
    return removeUndefinedOptions(options)
}

//the only data source whose requests are routed through the operator's gateways
const gatewayRoutedSource = 'exchanges'

/**
 * Whether this source must not be fetched because gateways are configured and none of them is usable.
 * The node checks this itself rather than relying on the connector.
 * @param {string} source - data source name
 * @returns {boolean}
 */
function hasNoGatewayRoute(source) {
    if (source !== gatewayRoutedSource)
        return false
    const urls = container.settingsManager?.gateways?.urls
    return Array.isArray(urls) && urls.length === 0
}

const baseExchangesAsset = new Asset(AssetType.OTHER, 'USD')
const baseStellarAsset = new Asset(AssetType.STELLAR, 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')

function getSourceDefaultBaseAsset(source) {
    switch (source) {
        case 'exchanges':
        case 'forex':
            return baseExchangesAsset
        case 'pubnet':
        case 'testnet':
            return baseStellarAsset
        default:
            return null
    }
}

/**
 * @param {number} timestamp - tick timestamp used to evaluate asset expiry
 * @returns {AssetsMap[]}
 */
function getAssetsMap(timestamp) {
    const {settingsManager} = container
    const oracleContracts = [...settingsManager.config.contracts.values()]
        .filter(c => c.type === ContractTypes.ORACLE || c.type === ContractTypes.ORACLE_BEAM)

    /**@type {Map<string,AssetsMap>} */
    const assetsMap = new Map()

    //push all oracle assets to the map
    //code-unit order: the asset map order feeds the price payload, so it must not depend on the process locale
    for (const contract of oracleContracts.sort((a, b) => compareStrings(a.contractId, b.contractId))) {
        addAssetToMap(assetsMap, contract.dataSource, contract.baseAsset, settingsManager.getAssets(contract.contractId, timestamp))
    }

    //push all subscriptions assets to the map
    for (const subscription of getAllSubscriptions()) {

        const baseAsset = getSourceDefaultBaseAsset(subscription.base.source)
        const quoteBaseAsset = getSourceDefaultBaseAsset(subscription.quote.source)
        if (!(baseAsset && quoteBaseAsset)) { //if the source is not supported
            logger.debug({msg: 'Subscription source base asset(s) not found', subscriptionId: subscription.id.toString()})
            continue
        }

        if (!baseAsset.equals(subscription.base.asset)) //if the base asset is not the same as the default one
            addAssetToMap(assetsMap, subscription.base.source, baseAsset, [subscription.base.asset])

        if (!quoteBaseAsset.equals(subscription.quote.asset)) //if the quote asset is not the same as the default one
            addAssetToMap(assetsMap, subscription.quote.source, quoteBaseAsset, [subscription.quote.asset])
    }
    return Array.from(assetsMap.values())
}

/**
 * Add asset to the map, ensure that the map is created if it doesn't exist
 * @param {Map<string,AssetsMap>} assetsMap - assets map
 * @param {string} source - source for the map
 * @param {AssetsMap.Asset} baseAsset - base asset
 * @param {AssetsMap.Asset[]} assets - assets
 */
function addAssetToMap(assetsMap, source, baseAsset, assets) {
    const key = formatSourceAssetKey(source, baseAsset)
    let am = assetsMap.get(key)
    if (!am) {//if the key doesn't exist, create a new map
        am = new AssetsMap(source, baseAsset)
        assetsMap.set(key, am)
    }
    am.push(assets.filter(a => a !== null)) //can contain null assets, if they are expired
}

function formatSourceAssetKey(source, baseAsset) {
    return `${source}_${baseAsset.code}`
}

/**
 * @returns {Set<string>} cache keys of every assets map this node loads, which are the only keys it reads
 */
function getLocalKeys() {
    try {
        //the key set does not depend on asset expiry - addAssetToMap opens a contract's map before it drops the expired
        //assets, and subscription assets never go through getAssets - so any integer minute gives every node the same
        //set, and the set never reaches a payload. The current minute only satisfies getAssets' timestamp requirement
        return new Set(getAssetsMap(getCurrentTimestampInfo().currentTimestamp).map(am => formatSourceAssetKey(am.source, am.baseAsset)))
    } catch (err) {
        //peer data is still cached and read; only the early release of the sync wait is lost
        logger.error({err, msg: 'Failed to build the local cache keys'})
        return new Set()
    }
}


/**
 * Serialises trades data into PRICE_SYNC messages of at most maxPriceSyncFrameBytes each. Keys are visited in sorted
 * order and each key's minutes in cache order, so the frames carry every item exactly once, whole, and are cut the same
 * way for the same data. An item is never split: a receiver merges item by item, so a peer is counted as presenting a
 * minute only once the whole item for it has arrived. An item larger than a frame that still fits the peer's cap goes
 * out alone, as it did before the cut; only an item no peer would accept is kept back
 * @param {Map<string, Map<number, TimestampTradeData>>} tradesData - trades data
 * @returns {Array<{type: number, data: Object.<string, Object.<number, any>>}>}
 */
function getPriceSyncMessages(tradesData) {
    const messages = []
    if (!tradesData)
        return messages
    const frameOverhead = Buffer.byteLength(JSON.stringify(priceSyncFrameEnvelope))
    let data = {}
    let bytes = frameOverhead
    for (const key of [...tradesData.keys()].sort()) {
        const sourceData = tradesData.get(key)
        for (const ts of sourceData.keys()) {
            const item = sourceData.get(ts).toPlainObject()
            //charged as if it opened its own key object, which overestimates a little, so a frame never exceeds the budget
            const itemBytes = Buffer.byteLength(JSON.stringify({[key]: {[ts]: item}}))
            if (frameOverhead + itemBytes > wsConstants.maxPayload) {
                logger.warn({msg: 'Price sync item is larger than a frame and is not sent', key, timestamp: ts, bytes: itemBytes})
                continue
            }
            if (bytes > frameOverhead && bytes + itemBytes > maxPriceSyncFrameBytes) {
                messages.push({type: MessageTypes.PRICE_SYNC, data})
                data = {}
                bytes = frameOverhead
            }
            if (!data[key])
                data[key] = {}
            data[key][ts] = item
            bytes += itemBytes
        }
    }
    if (bytes > frameOverhead)
        messages.push({type: MessageTypes.PRICE_SYNC, data})
    return messages
}

/**
 * Returns the normalized current timestamp and the timestamp of the last completed trades data (basically it's from timestamp)
 * @returns {{currentTimestamp: number, tradesTimestamp: number}}
 */
function getCurrentTimestampInfo() {
    const currentTimestamp = normalizeTimestamp(Date.now(), minute)
    return {
        currentTimestamp,
        tradesTimestamp: currentTimestamp - minute
    }
}

class TimestampSyncItem {
    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @param {number} maxTime - max time
     */
    constructor(key, timestamp, maxTime) {
        this.key = key
        this.timestamp = timestamp
        this.isProcessed = false

        this.maxTime = maxTime
        this.__createdAt = Date.now()

        const rawTimeout = this.maxTime - Date.now()
        //a non-numeric maxTime makes the delay NaN; setTimeout would clamp that to 1 ms and resolve every item
        //through the timeout path instead of peer presentation. A deadline already past - a peer's
        //backfill for a minute whose sync window has closed - still fires at once, as setTimeout would make it,
        //without the TimeoutNegativeWarning Node prints for a negative delay. A delay past the timer range - a
        //deadline more than about 24.8 days ahead - would be replaced with 1 ms too, so it is capped at the range.
        const timeout = Number.isFinite(rawTimeout) ? Math.min(maxTimerDelay, Math.max(1, rawTimeout)) : defaultSyncWait
        //an entry opened after its own deadline - a peer's backfill for a minute whose sync window has closed - waited for
        //nothing, so its resolution is no operator signal; one PRICE_SYNC can open such an entry for every minute of the
        //window and every local key
        const openedLate = Number.isFinite(rawTimeout) && rawTimeout <= 0
        if (!Number.isFinite(rawTimeout))
            logger.error({msg: 'Non-finite sync timeout; falling back to the default wait', key, timestamp, maxTime: this.maxTime})
        const timeoutId = setTimeout(() => {
            //auto-resolve on timeout: log which peers never presented so
            //operators can trace a stall to the specific unresponsive node.
            const expectedPubkeys = container.settingsManager.config?.nodes
                ? [...container.settingsManager.config.nodes.keys()]
                : []
            const missing = expectedPubkeys.filter(p => !this.__presentedPubkeys.has(p))
            logger[openedLate ? 'debug' : 'warn']({
                msg: 'TimestampSyncItem auto-resolved by timeout',
                key: this.key,
                timestamp: this.timestamp,
                missing,
                waitedMs: Date.now() - this.__createdAt
            })
            this.resolve(true)
        }, timeout)

        this.readyPromise = new Promise((resolve) => {
            this.resolve = (timedOut = false) => {
                if (this.isProcessed)
                    return
                clearTimeout(timeoutId)
                this.isProcessed = true
                logger.trace({msg: 'Pending trades data resolved', ...this.getDebugInfo(), timedOut})
                resolve()
            }
        })
    }

    __presentedPubkeys = new Set()

    add(pubkey) {
        this.__presentedPubkeys.add(pubkey)
        const isReady = () => {
            const currentNodePubkey = container.settingsManager.appConfig.publicKey
            return !this.isProcessed //if not processed yet
            && this.__presentedPubkeys.has(currentNodePubkey) //if the current node is in the list
            //if we have all possible nodes data or the majority is enough
            //subtract 1 because we already have the current node data, and it's not included in the connected nodes
            && (this.__presentedPubkeys.size - 1) >= nodesManager.getConnectedNodes().length
            && hasMajority(container.settingsManager.config.nodes.size, this.__presentedPubkeys.size) //if we have majority
        }
        if (isReady()) //if we have all nodes data
            this.resolve()
    }

    getDebugInfo() {
        return {
            key: this.key,
            timestamp: this.timestamp,
            maxTime: this.maxTime,
            isProcessed: this.isProcessed,
            pubkeys: [...this.__presentedPubkeys.values()],
            currentTime: Date.now()
        }
    }
}

class TradesManager {

    constructor() {
        this.__clearPendingTradesDataWorker()
    }

    /**
     * Stops the cleanup worker and releases every open sync entry, so nothing this manager armed stays pending
     */
    stop() {
        clearTimeout(this.__cleanupTimeout)
        for (const keyData of this.__timestamps.values())
            for (const item of keyData.values())
                item.resolve(true)
        this.__timestamps.clear()
    }

    __cleanupTimeout = null

    __clearPendingTradesDataWorker() {
        //unref: housekeeping must never keep the process alive on its own
        this.__cleanupTimeout = setTimeout(() => {
            try {
                //No peer item older than the ingest window is accepted, and no read reaches back a whole heartbeat
                //while a contract's timeframe stays below it. A key whose newest data is older than that is one
                //nothing loads any more - a removed contract's - and it goes, or its first timestamp would pin the
                //cutoff below for the node's uptime and keep the sync map at its cap.
                const horizon = Date.now() - getRetentionHeartbeat() - 2 * minute
                this.__trades.removeStaleKeys(horizon)
                const firstTimestamp = Math.max(this.__trades.getAbsoluteFirstTimestamp(), horizon)
                for (const [timestamp, keyData] of this.__timestamps) { //delete all timestamps that are older than the cache
                    if (timestamp < firstTimestamp) { //if the timestamp is older than the cache
                        logger.debug({msg: 'Clearing pending trades data', timestamp})
                        //resolve before deleting, or the entry's setTimeout stays armed with nothing left to
                        //resolve and fires into a map that no longer holds it
                        for (const item of keyData.values())
                            item.resolve(true)
                        this.__timestamps.delete(timestamp)
                    }
                }
            } catch (err) {
                logger.error({err, msg: 'Error clearing pending trades data'})
            }
            this.__clearPendingTradesDataWorker()
        }, minute)
        this.__cleanupTimeout.unref?.()
    }

    __trades = new TradesCache()

    /**
     * @type {Map<number, Map<string, TimestampSyncItem>>}
     */
    __timestamps = new Map()

    /**
     * Adds trade data that were synchronized from other nodes. Every item is validated and rebuilt before it touches
     * the cache, so a malformed or oversized payload can neither be stored nor throw when it is read.
     * @param {string} pubkey - public key
     * @param {Object.<string, Object.<number, TimestampTradeData>>} tradesData - price data
     */
    addSyncData(pubkey, tradesData) {
        if (!tradesData || typeof tradesData !== 'object' || Array.isArray(tradesData)) {
            logger.debug({msg: 'Malformed price sync payload', node: pubkey})
            return
        }
        const entries = Object.entries(tradesData)
        if (entries.length > maxSyncKeys) {
            logger.debug({msg: 'Price sync payload carries too many keys', node: pubkey, keys: entries.length})
            return
        }
        const now = Date.now()
        //PRICE_SYNC arrives only on an incoming channel from a key in the node list, and the node list is set only by
        //SettingsManager.setConfig, after it has assigned the config, so the heartbeat is always there to read
        const priceHeartbeat = getRetentionHeartbeat()
        const localKeys = getLocalKeys()
        const maxSyncTimestamps = getMaxSyncTimestamps(priceHeartbeat)
        for (const [key, timestampData] of entries) {
            if (!timestampData || typeof timestampData !== 'object' || Array.isArray(timestampData))
                continue
            let timestampEntries = Object.entries(timestampData)
            if (timestampEntries.length > maxSyncTimestamps) {
                //A sender on a longer heartbeat than ours - a config change adopted at different moments - holds more
                //timestamps per key than our window has minutes, and the part of its backfill inside the window must
                //survive. The rest would be rejected one by one below anyway; dropping it here first costs a
                //comparison per entry instead of an Error, and whatever still exceeds the bound can only be repeated
                //or unaligned timestamps, which no honest sender produces.
                const {from, to} = getSyncWindow(now, priceHeartbeat)
                const inWindow = timestampEntries.filter(([rawTimestamp]) => {
                    const timestamp = Number(rawTimestamp)
                    return timestamp >= from && timestamp <= to
                })
                logger.debug({msg: 'Price sync timestamps outside the window skipped', node: pubkey, key, skipped: timestampEntries.length - inWindow.length})
                timestampEntries = inWindow
            }
            if (timestampEntries.length > maxSyncTimestamps) {
                logger.debug({msg: 'Price sync payload carries too many timestamps', node: pubkey, key, timestamps: timestampEntries.length})
                continue
            }
            for (const [rawTimestamp, data] of timestampEntries) {
                try {
                    const normalizedTimestamp = Number(rawTimestamp)
                    const validated = validatePriceSyncItem(key, normalizedTimestamp, data, now, priceHeartbeat)
                    this.__trades.push(
                        pubkey,
                        key,
                        new AssetsMap(validated.assetsMap.source, validated.assetsMap.baseAsset, validated.assetsMap.assets),
                        normalizedTimestamp,
                        validated.trades
                    )
                    //the byte budget can evict the item just pushed - an item older than all a peer holds - and a peer
                    //that holds nothing for the minute must not count as having presented it
                    if (!this.__trades.hasData(pubkey, key, normalizedTimestamp))
                        continue
                    //Only a key this node reads gets a sync entry. An entry resolves early only once the current node
                    //has presented its own data for the key, so nothing ever waits on any other key, and registering
                    //one would let a peer arm a timer per fresh key and minute that its own 32-key cache has already
                    //dropped. A key a peer gossips before the local config lists it gets its sync entry on
                    //its first read instead of on arrival, and that entry then credits every node already holding the
                    //minute. An entry that is already open still records the peer when the key is briefly not read -
                    //a contract removed and re-added, or a key list that failed to build - or it would wait out its
                    //deadline; that path never opens an entry or arms a timer.
                    if (localKeys.has(key))
                        this.__getOrAddTimestampSync(key, normalizedTimestamp).add(pubkey)
                    else
                        this.__timestamps.get(normalizedTimestamp)?.get(key)?.add(pubkey)
                } catch (err) {
                    logger.debug({msg: 'Rejected sync data', node: pubkey, key, lastTimestamp: rawTimestamp, err: err.message})
                }
            }
        }
    }

    /**
     * @param {string} pubKey - public key
     * @returns {void}
     */
    sendTradesData(pubKey) {
        //a reconnect backfill holds the whole heartbeat window, so it goes out in frames under the peer cap
        for (const message of getPriceSyncMessages(this.__trades.getAll()))
            nodesManager.sendTo(pubKey, message)
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @returns {TimestampSyncItem}
     */
    __getOrAddTimestampSync(key, timestamp) {
        //sync auto-resolves at T + priceSyncDelay 15s + 25s = T + 40s, so it finishes well before
        //the oracle attempt-1 envelope (T + roundSyncDelay 20s + firstAttemptTimeout 40s
        //= T + 60s), leaving at least 20s for the worker to build and submit.
        //Pre-fix 35s collided with the pre-fix 15s attempt-0 window and left the
        //worker no room after a sync timeout.
        const maxTime = timestamp + priceSyncDelay + defaultSyncWait

        let timestampSyncData = this.__timestamps.get(timestamp)
        if (!timestampSyncData) {
            if (timestamp % minute !== 0)
                throw new Error(`Timestamp ${timestamp} is invalid`)
            //evict, never throw: this runs on the read path too (getTradesData), outside any try, and a throw would
            //kill the tick for every contract on every node. Oldest by TIMESTAMP, not by insertion order, because
            //insertion order is something a peer chooses.
            const maxPendingTimestamps = getMaxPendingTimestamps()
            while (this.__timestamps.size >= maxPendingTimestamps) {
                const oldest = [...this.__timestamps.keys()].sort((a, b) => a - b)[0]
                for (const item of this.__timestamps.get(oldest).values())
                    item.resolve(true)
                this.__timestamps.delete(oldest)
                logger.debug({msg: 'Pending timestamp map is full, evicting the oldest timestamp', timestamp: oldest})
            }
            timestampSyncData = new Map()
            this.__timestamps.set(timestamp, timestampSyncData)
        }
        let syncData = timestampSyncData.get(key)
        if (!syncData) {
            syncData = new TimestampSyncItem(key, timestamp, maxTime)
            timestampSyncData.set(key, syncData)
            //credit every node that already holds the minute: addSyncData registers a peer only for a key this node
            //reads, so a peer's data can arrive before the entry exists, and it counts as presented all the same
            for (const pubkey of this.__trades.getNodesWithData(key, timestamp))
                syncData.add(pubkey)
        }
        logger.trace({msg: 'Getting timestamp sync', ...syncData.getDebugInfo()})
        return syncData
    }

    /**
     * @param {AssetsMap} assetsMap - asset map
     */
    async loadTradesDataForSource(assetsMap) {
        const {currentTimestamp, tradesTimestamp} = getCurrentTimestampInfo()
        logger.trace({assetsMap: assetsMap.toPlainObject(), msg: 'Loading trades data for the asset map', tradesTimestamp, currentTimestamp})

        const {source, baseAsset} = assetsMap

        //configured gateways, none usable: no route, so nothing is fetched rather than fetched directly. This only drops
        //this node's own samples for the tick, exactly as a failed fetch does; what it signs is still decided by the
        //samples a majority of the cluster reported, so consensus is untouched
        if (hasNoGatewayRoute(source)) {
            if (this.__noGatewayRouteWarnedAt !== currentTimestamp) { //once per tick, however many maps the source has
                this.__noGatewayRouteWarnedAt = currentTimestamp
                logger.warn({msg: 'Gateways are configured but none is usable; exchanges prices are not fetched rather than fetched directly', source, timestamp: currentTimestamp})
            }
            return
        }

        const key = formatSourceAssetKey(source, baseAsset)
        const lastTimestamp = this.__trades.getLastTimestamp(key)

        const count = getSampleSize(lastTimestamp, currentTimestamp)
        //if count is greater than 0, then we need to load volumes
        if (count === 0) {
            logger.trace({msg: 'Skipping trades loading', source, baseAsset: baseAsset.toString(), tradesTimestamp, lastTimestamp, currentTimestamp})
            return
        }

        const from = tradesTimestamp - ((count - 1) * minute)
        logger.trace({msg: 'Loading trades data for source', source, baseAsset: baseAsset.toString(), currentTimestamp, tradesTimestamp, from, count})

        const dataSource = dataSourcesManager.get(source)
        if (!dataSource) {
            throw new Error(`Data source ${source} not found`)
        }

        //load the data
        const priceData = await loadPriceData(dataSource, baseAsset, assetsMap.assets, from, count)
        if (!Array.isArray(priceData))
            throw new Error(`Data source ${source} returned no rows`)
        //rows are dated backward from the current minute, so fewer periods than asked misdates every row unless the
        //missing ones are the oldest
        if (priceData.length !== count)
            logger.warn({msg: 'Data source returned an unexpected number of rows', source, expected: count, received: priceData.length})

        //iterate over the data from the current node, starting from the latest timestamp
        let currentIterationTimestamp = currentTimestamp
        //broadcast items
        const broadcastItems = new Map([[key, new Map()]])
        const pubkey = container.settingsManager.appConfig.publicKey
        //push volumes to the cache
        for (let j = priceData.length - 1; j >= 0; j--) {
            const currentTimestampData = priceData[j]
            //push the data to verified data
            const tradeDataItem = this.__trades.push(
                pubkey,
                key,
                assetsMap,
                currentIterationTimestamp,
                currentTimestampData
            )
            this.__getOrAddTimestampSync(key, currentIterationTimestamp).add(pubkey)
            broadcastItems.get(key).set(currentIterationTimestamp, tradeDataItem)
            currentIterationTimestamp = currentIterationTimestamp - minute
        }
        //broadcast the data, in frames under the peer cap: a fresh cache sends 15 minutes of a map at once
        for (const message of getPriceSyncMessages(broadcastItems))
            nodesManager.broadcast(message)

        logger.trace({msg: 'Pushed trades data for source', source, baseAsset, from, to: from + (count - 1) * minute})
    }

    __pendingTradesRequest = new Map()

    /**
     * Load trades data for every asset map the cluster currently needs
     * @param {number} timestamp - tick timestamp of the price runner
     * @returns {void}
     */
    loadTradesData(timestamp) {
        const assetsMaps = getAssetsMap(timestamp)
        for (const assetsMap of assetsMaps.filter(a => a.assets.length > 0))
            this.__loadDataForAssetMap(assetsMap)
    }

    __loadDataForAssetMap(assetsMap) {
        const {source, baseAsset} = assetsMap
        const key = formatSourceAssetKey(source, baseAsset)
        try {
            let pendingRequest = this.__pendingTradesRequest.get(key)
            //set new version of asset map
            if (pendingRequest) {
                pendingRequest.nextMap = assetsMap
                return
            }
            //register new request
            pendingRequest = {promise: runWithContext(async () => await this.loadTradesDataForSource(assetsMap))}
            //register catch and finally
            pendingRequest
                .promise
                .catch(err => {
                    if (err?.skipped) //a key held by an unsettled call: loadPriceData has logged it
                        return
                    logger.error({err, msg: 'Error loading prices for source', source: assetsMap.source, baseAsset: assetsMap.baseAsset.toString()})
                })
                .finally(() => {
                    const {nextMap} = this.__pendingTradesRequest.get(key)
                    this.__pendingTradesRequest.delete(key)
                    if (nextMap) {
                        this.__loadDataForAssetMap(nextMap)
                    }
                })
            //set pending request
            this.__pendingTradesRequest.set(key, pendingRequest)
        } catch (err) {
            logger.error({err, msg: 'Error loading trades data for source', source, baseAsset})
        }
    }

    async getTradesData(source, baseAsset, assets, timestamp) {
        const key = formatSourceAssetKey(source, baseAsset)
        logger.debug({msg: 'Waiting for pending trades data', key, timestamp})
        await this.__getOrAddTimestampSync(key, timestamp)
            .readyPromise
            .catch(err => logger.error({err, msg: 'Error getting pending trades data', key, timestamp}))
        logger.debug({msg: 'Pending trades data is ready', key, timestamp})
        return this.__trades.getTradesData(key, timestamp, assets)
    }

    /**
     * Set the nodes for which to cache trades data
     * @param {string[]} nodes - nodes pubkeys
     */
    setNodes(nodes) {
        this.__trades.setNodes(nodes)
    }
}

module.exports = TradesManager
module.exports.TimestampSyncItem = TimestampSyncItem
module.exports.normalizePriceDataFetchOptions = normalizePriceDataFetchOptions
//test seams: loadPriceData is where the budget lives, getPriceFetchTimeout is how long it is, and getSampleSize decides
//whether loadTradesDataForSource ever reaches it. Nothing in src/ calls any of them through the export.
module.exports.__loadPriceData = loadPriceData
module.exports.__getSampleSize = getSampleSize
module.exports.__getPriceFetchTimeout = getPriceFetchTimeout
module.exports.__getPriceSyncMessages = getPriceSyncMessages