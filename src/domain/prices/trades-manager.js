const {normalizeTimestamp, Asset, AssetType, ContractTypes, hasMajority} = require('@reflector/reflector-shared')
const dataSourcesManager = require('../data-sources-manager')
const logger = require('../../logger')
const container = require('../container')
const {getAllSubscriptions} = require('../subscriptions/subscriptions-data-manager')
const nodesManager = require('../nodes/nodes-manager')
const MessageTypes = require('../../ws-server/handlers/message-types')
const {runWithContext} = require('../../async-storage')
const TradesCache = require('./trades-cache')
const AssetsMap = require('./assets-map')

//TODO: implement timestamp manager, to avoid confusion with the timestamps

const cacheSize = 15
const minute = 60 * 1000

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
 * @param {any} dataSource - source
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets
 * @param {number} from - from miliseconds timestamp
 * @param {number} count - count of items to load
 * @return {Promise<AggregatedTradeData>}
 */
async function loadPriceData(dataSource, baseAsset, assets, from, count) {
    from = from / 1000 //convert to seconds
    const start = Date.now()
    const requestOptions = normalizePriceDataFetchOptions(dataSource, baseAsset, assets, from, minute / 1000, count)
    const tradesData = await dataSource.instance.getPriceData(requestOptions)
    logger.info({msg: 'Loaded trade data', count: tradesData.length, source: dataSource.name, duration: Date.now() - start})
    return tradesData
}

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
        simSource: settingsManager.getSimSource()
    }
    //remove all undefined options
    const removeUndefinedOptions = (raw) => {
        for (const key of Object.keys(raw)) {
            if (raw[key] === undefined)
                delete raw[key]
            else if (typeof raw[key] === 'object' && !Array.isArray(raw[key]))
                raw[key] = removeUndefinedOptions(raw[key])
        }
        return raw
    }
    return removeUndefinedOptions(options)
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
 * @returns {AssetsMap[]}
 */
function getAssetsMap() {
    const {settingsManager} = container
    const oracleContracts = [...settingsManager.config.contracts.values()]
        .filter(c => c.type === ContractTypes.ORACLE || c.type === ContractTypes.ORACLE_BEAM)

    /**@type {Map<string,AssetsMap>} */
    const assetsMap = new Map()

    //push all oracle assets to the map
    for (const contract of oracleContracts.sort((a, b) => a.contractId.localeCompare(b.contractId))) {
        addAssetToMap(assetsMap, contract.dataSource, contract.baseAsset, settingsManager.getAssets(contract.contractId))
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
 * @param {Map<string, Map<number, TimestampTradeData>>} tradesData - trades data
 * @returns {any}
 */
function getPriceSyncMessage(tradesData) {
    /**
     * @param {Map<string, Map<number, TimestampTradeData>>} tradesData - trades data
     * @returns {Object.<string, Object.<number, any>>}
     */
    function serialize(tradesData) {
        const plainData = {}
        for (const key of [...tradesData.keys()].sort()) {
            plainData[key] = {}
            const sourceData = tradesData.get(key)
            for (const ts of sourceData.keys()) {
                const cacheItem = sourceData.get(ts).toPlainObject()
                plainData[key][ts] = cacheItem
            }
        }
        return plainData
    }

    return {
        type: MessageTypes.PRICE_SYNC,
        data: serialize(tradesData)
    }
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

        const timeout = this.maxTime - Date.now()
        const timeoutId = setTimeout(() => {
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

    __clearPendingTradesDataWorker() {
        setTimeout(() => {
            const firstTimestamp = this.__trades.getAbsoluteFirstTimestamp()
            for (const [timestamp] of this.__timestamps) { //delete all timestamps that are older than the cache
                if (timestamp < firstTimestamp) { //if the timestamp is older than the cache
                    logger.debug({msg: 'Clearing pending trades data', timestamp})
                    this.__timestamps.delete(timestamp)
                }
            }
            this.__clearPendingTradesDataWorker()
        }, minute)
    }

    __trades = new TradesCache()

    /**
     * @type {Map<number, Map<string, TimestampSyncItem>>}
     */
    __timestamps = new Map()

    /**
     * Adds trade data that were synchronized from other nodes
     * @param {string} pubkey - public key
     * @param {Object.<string, Object.<number, TimestampTradeData>>} tradesData - price data
     */
    addSyncData(pubkey, tradesData) {
        for (const [key, timestampData] of Object.entries(tradesData)) {
            for (const [timestamp, data] of Object.entries(timestampData)) {
                try {
                    const normalizedTimestamp = Number(timestamp)
                    this.__trades.push(
                        pubkey,
                        key,
                        new AssetsMap(data.assetsMap.source, data.assetsMap.baseAsset, data.assetsMap.assets),
                        normalizedTimestamp,
                        data.trades
                    )
                    this.__getOrAddTimestampSync(key, normalizedTimestamp).add(pubkey)
                } catch (err) {
                    logger.debug({msg: 'Error adding sync data', key, lastTimestamp: timestamp, error: err.message})
                }
            }
        }
    }

    /**
     * @param {string} pubKey - public key
     * @returns {void}
     */
    sendTradesData(pubKey) {
        nodesManager.sendTo(pubKey, getPriceSyncMessage(this.__trades.getAll()))
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @returns {TimestampSyncItem}
     */
    __getOrAddTimestampSync(key, timestamp) {
        const maxTime = timestamp
            + container.settingsManager.appConfig.dbSyncDelay //add db sync delay
            + 35 * 1000 //30 seconds for trades data fetching, and 5 seconds for the nodes sync

        let timestampSyncData = this.__timestamps.get(timestamp)
        if (!timestampSyncData) {
            if (timestamp % minute !== 0)
                throw new Error(`Timestamp ${timestamp} is invalid`)
            timestampSyncData = new Map()
            this.__timestamps.set(timestamp, timestampSyncData)
        }
        let syncData = timestampSyncData.get(key)
        if (!syncData) {
            syncData = new TimestampSyncItem(key, timestamp, maxTime)
            timestampSyncData.set(key, syncData)
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
        //broadcast the data
        nodesManager.broadcast(getPriceSyncMessage(broadcastItems))

        logger.trace({msg: 'Pushed trades data for source', source, baseAsset, from, to: from + (count - 1) * minute})
    }

    __pendingTradesRequest = new Map()

    /**
     * Load trades data
     * @param {[string]} key - key to load
     * @param {number} timestamp - timestamp
     * @returns {Promise}
     */
    loadTradesData() {
        const assetsMaps = getAssetsMap()
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
                .catch(err => logger.error({err, msg: 'Error loading prices for source', source: assetsMap.source, baseAsset: assetsMap.baseAsset.toString()}))
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