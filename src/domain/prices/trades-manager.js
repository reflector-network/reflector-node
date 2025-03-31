const {normalizeTimestamp, Asset, AssetType, ContractTypes, hasMajority} = require('@reflector/reflector-shared')
const {getTradesData} = require('@reflector/reflector-exchanges-connector')
const {getTradesData: getFiatTradesData} = require('@reflector/fiat-exchanges-connector')
const {aggregateTrades} = require('@reflector/reflector-stellar-connector')
const DataSourceTypes = require('../../models/data-source-types')
const dataSourcesManager = require('../data-sources-manager')
const logger = require('../../logger')
const container = require('../container')
const {getAllSubscriptions} = require('../subscriptions/subscriptions-data-manager')
const nodesManager = require('../nodes/nodes-manager')
const MessageTypes = require('../../ws-server/handlers/message-types')
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
function loadTradesData(dataSource, baseAsset, assets, from, count) {
    from = from / 1000 //convert to seconds
    let dataPromise = null
    const start = Date.now()
    switch (dataSource.type) {
        case DataSourceTypes.API:
            dataPromise = loadApiTradesData(dataSource, baseAsset, assets, from, count)
            break
        case DataSourceTypes.DB:
            dataPromise = loadDbTradesData(dataSource, baseAsset, assets, from, count)
            break
        default:
            throw new Error(`Data source ${dataSource.type} not supported`)
    }
    dataPromise
        .then(data => logger.info(`Loaded ${data.length} trade data from ${dataSource.name} in ${Date.now() - start}ms`))
    return dataPromise
}

/**
 * @param {any} dataSource - source object
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets
 * @param {number} from - timestamp
 * @param {number} count - count of items to load
 * @returns {Promise<AggregatedTradeData>}
 */
async function loadApiTradesData(dataSource, baseAsset, assets, from, count) {
    const {settingsManager} = container
    const gatewaysCount = settingsManager.gateways?.urls?.length || 1
    switch (dataSource.name) {
        case 'exchanges': {
            const tradesData = await getTradesData(
                assets.map(asset => asset.code),
                baseAsset.code,
                from,
                minute / 1000,
                count,
                {
                    batchSize: gatewaysCount * 10,
                    batchDelay: 1500
                }
            )
            return tradesData
        }
        case 'forex': {
            const tradesData = await getFiatTradesData(
                assets.map(asset => asset.code),
                baseAsset.code,
                from,
                minute / 1000,
                count,
                {
                    sources: dataSource.providers,
                    timeout: 15000
                })
            return tradesData
        }
        default:
            throw new Error(`Data source ${dataSource.name} not supported`)
    }
}

/**
 * @param {any} dataSource - source object
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets
 * @param {number} from - timestamp
 * @param {number} count - count of items to load
 * @returns {Promise<AggregatedTradeData>}
 */
async function loadDbTradesData(dataSource, baseAsset, assets, from, count) {
    const {sorobanRpc} = dataSource
    let tradesData = null
    for (const rpcUrl of sorobanRpc) {
        try {
            const options = {rpcUrl, baseAsset, assets, from, period: minute / 1000, limit: count}
            tradesData = await aggregateTrades(options)
            break
        } catch (err) {
            logger.error({err}, `Error loading trades data from ${rpcUrl}`)
        }
    }

    if (!tradesData)
        throw new Error(`Failed to load trades data from ${dataSource.name}`)

    //normalize data to the same format as API data
    for (let tsIndex = 0; tsIndex < tradesData.length; tsIndex++) {
        const tsTrades = tradesData[tsIndex]
        for (let assetIndex = 0; assetIndex < tsTrades.length; assetIndex++) {
            const tradesData = tsTrades[assetIndex]
            tradesData.source = dataSource.name
            tsTrades[assetIndex] = [tradesData]
        }
    }
    return tradesData
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
        .filter(c => c.type === ContractTypes.ORACLE)

    /**@type {Map<string,AssetsMap>} */
    const assetsMap = new Map()


    //push all oracle assets to the map
    for (const contract of oracleContracts.sort((a, b) => a.contractId.localeCompare(b.contractId))) {
        addAssetToMap(assetsMap, contract.dataSource, contract.baseAsset, settingsManager.getAssets(contract.contractId, true))
    }

    //push all subscriptions assets to the map
    for (const subscription of getAllSubscriptions()) {

        const baseAsset = getSourceDefaultBaseAsset(subscription.base.source)
        const quoteBaseAsset = getSourceDefaultBaseAsset(subscription.quote.source)
        if (!(baseAsset && quoteBaseAsset)) { //if the source is not supported
            logger.debug(`Subscription ${subscription.id} source base asset(s) not found`)
            continue
        }

        if (!baseAsset.equals(subscription.base.asset)) //if the base asset is not the same as the default one
            addAssetToMap(assetsMap, subscription.base.source, baseAsset, [subscription.base.asset])

        if (!quoteBaseAsset.equals(subscription.quote.asset)) //if the quote asset is not the same as the default one
            addAssetToMap(assetsMap, subscription.quote.source, quoteBaseAsset, [subscription.quote.asset])
    }
    return Array.from(assetsMap.values())
}

//add asset to the map function
function addAssetToMap(assetsMap, source, baseAsset, assets) {
    const key = formatSourceAssetKey(source, baseAsset)
    let am = assetsMap.get(key)
    if (!am) {//if the key doesn't exist, create a new map
        am = new AssetsMap(source, baseAsset)
        assetsMap.set(key, am)
    }
    am.push(assets)
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
 * @returns {{currentTimestamp: number, tradesTimestamp: number}}
 */
function getCurrentTimestampInfo() {
    const currentTimestamp = normalizeTimestamp(Date.now(), minute)
    const timestamp = currentTimestamp - minute
    return {
        currentTimestamp,
        tradesTimestamp: timestamp
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
            logger.debug(`Pending trades data timed out. Key: ${this.key}, timestamp: ${this.timestamp}, maxTime: ${this.maxTime}, isProcessed: ${this.isProcessed}, pubkeys: ${[...this.__presentedPubkeys.values()].join(',')}, current time: ${Math.floor(Date.now())}`)

            if (this.isProcessed) //if the data is already processed
                return
            else if (this.__isReady(true)) { //if we have majority
                logger.trace(`Processing pending trades data on timeout. Key: ${this.key}, timestamp: ${this.timestamp}.`)
                this.resolve()
                return
            }

            this.reject(new Error(`Pending trades data timed out. Key: ${this.key}, timestamp: ${this.timestamp}.`))
        }, timeout)

        const markProcessed = () => {
            if (this.isProcessed)
                return false
            clearTimeout(timeoutId)
            this.isProcessed = true
            return true
        }

        this.readyPromise = new Promise((resolve, reject) => {
            this.resolve = () => {
                if (!markProcessed())
                    return
                logger.trace(`Pending trades data ready. Key: ${this.key}, timestamp: ${this.timestamp}, maxTime: ${this.maxTime}, pubkeys: ${[...this.__presentedPubkeys.values()].join(',')}, current time: ${Math.floor(Date.now() / 1000)}`)
                resolve()
                this.resolved = true
            }
            this.reject = (err) => {
                if (!markProcessed())
                    return
                logger.error({err}, `Error processing pending trades data. Key: ${this.key}, timestamp: ${this.timestamp}, maxTime: ${this.maxTime}, pubkeys: ${[...this.__presentedPubkeys.values()].join(',')}, current time: ${Math.floor(Date.now() / 1000)}`)
                reject(err)
            }
        })
    }

    __presentedPubkeys = new Set()

    add(pubkey) {
        this.__presentedPubkeys.add(pubkey)
        if (this.__isReady()) { //if we have all nodes data
            logger.debug(`Pending timestamp ready. Key: ${this.key}, timestamp: ${this.timestamp}.`)
            this.resolve()
        }
    }

    __isReady(majorityEnought = false) {
        const currentNodePubkey = container.settingsManager.appConfig.publicKey
        return !this.isProcessed //if not processed yet
            && this.__presentedPubkeys.has(currentNodePubkey) //if the current node is in the list
            //if we have all possible nodes data or we majority is enough
            //subtract 1 because we already have the current node data, and it's not included in the connected nodes
            && (majorityEnought || (this.__presentedPubkeys.size - 1) >= nodesManager.getConnectedNodes().length)
            && hasMajority(container.settingsManager.config.nodes.size, this.__presentedPubkeys.size) //if we have majority
    }

    getDebugInfo() {
        return `Key: ${this.key}, timestamp: ${this.timestamp}, maxTime: ${this.maxTime}, isProcessed: ${this.isProcessed}, pubkeys: ${[...this.__presentedPubkeys.values()].join(',')}, resolved: ${!!this.resolved}`
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
                    logger.debug(`Clearing pending trades data for timestamp ${timestamp}`)
                    this.__timestamps.delete(timestamp)
                }
            }
            this.__clearPendingTradesDataWorker()
        }, minute)
    }

    __trades = new TradesCache()

    __timestamps = new Map()

    /**
     * @param {string} pubkey - public key
     * @param {Object.<string, Object.<number, TimestampTradeData>>} tradesData - price data
     */
    addSyncData(pubkey, tradesData) {
        for (const [key, timestampData] of Object.entries(tradesData)) {
            let lastTimestamp = 0
            for (let [timestamp, data] of Object.entries(timestampData)) {
                timestamp = Number(timestamp)
                this.__trades.push(
                    pubkey,
                    key,
                    new AssetsMap(data.assetsMap.source, data.assetsMap.baseAsset, data.assetsMap.assets),
                    timestamp,
                    data.trades
                )
                lastTimestamp = Math.max(lastTimestamp, timestamp)
            }
            try {
                this.__getOrAddTimestampSync(key, lastTimestamp).add(pubkey)
            } catch (err) {
                logger.debug(`Error adding sync data for key ${key}, last timestamp ${lastTimestamp}. ${err.message}`)
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
        const currentTimestamp = timestamp + minute //trades data timestamp, basically current normalized timestamp - 1 minute, so add 1 minute to the timestamp
        const maxTime = currentTimestamp
            + container.settingsManager.appConfig.dbSyncDelay //add db sync delay
            + 35 * 1000 //30 seconds for trades data fetching, and 5 seconds for the nodes sync

        if (maxTime < Date.now())
            throw new Error(`Timestamp ${timestamp} is too old. Current timestamp: ${currentTimestamp}, maxTime: ${maxTime}, current time: ${Math.floor(Date.now() / 1000)}`)

        let timestampPendingData = this.__timestamps.get(timestamp)
        if (!timestampPendingData) {
            if (timestamp % minute !== 0)
                throw new Error(`Timestamp ${timestamp} is invalid`)
            timestampPendingData = new Map()
            this.__timestamps.set(timestamp, timestampPendingData)
        }
        let pendingData = timestampPendingData.get(key)
        if (!pendingData) {
            pendingData = new TimestampSyncItem(key, timestamp, maxTime)
            timestampPendingData.set(key, pendingData)
        }
        logger.trace(`Getting timestamp sync. ${pendingData.getDebugInfo()}`)
        return pendingData
    }

    /**
     * @param {AssetsMap} assetsMap - asset map
     */
    async loadTradesDataForSource(assetsMap) {
        /**@type {TimestampSyncItem} */
        let timestampSync = null
        try {
            const {currentTimestamp, tradesTimestamp} = getCurrentTimestampInfo()
            logger.trace({assetsMap: assetsMap.toPlainObject()}, `Loading trades data for the asset map at timestamp ${tradesTimestamp}, current timestamp ${currentTimestamp}`)

            const {source, baseAsset} = assetsMap

            const key = formatSourceAssetKey(source, baseAsset)
            const lastTimestamp = this.__trades.getLastTimestamp(key)

            const count = getSampleSize(lastTimestamp, tradesTimestamp)
            //if count is greater than 0, then we need to load volumes
            if (count === 0) {
                logger.trace(`Skipping trades loading for source ${source}, base asset ${baseAsset}, timestamp ${tradesTimestamp}, last timestamp ${lastTimestamp}, current timestamp ${currentTimestamp}`)
                return
            }

            timestampSync = this.__getOrAddTimestampSync(key, tradesTimestamp)

            const from = tradesTimestamp - ((count - 1) * minute)

            logger.trace(`Loading trades data for source ${source}, base asset ${baseAsset}, timestamp ${tradesTimestamp}, from ${from}, count ${count}`)

            const dataSource = dataSourcesManager.get(source)

            //load the data
            const tradesData = await loadTradesData(dataSource, baseAsset, assetsMap.assets, from, count)

            //iterate over the data from the current node, starting from the latest timestamp
            let currentIterationTimestamp = tradesTimestamp
            //broadcast items
            const broadcastItems = new Map([[key, new Map()]])
            //push volumes to the cache
            for (let j = tradesData.length - 1; j >= 0; j--) {
                const currentTimestampData = tradesData[j]
                //TODO: remove this check
                logger.trace(`Performing timestamp ${currentIterationTimestamp} check for source ${source}, base asset ${baseAsset}`)
                for (let assetIndex = 0; assetIndex < currentTimestampData.length; assetIndex++) {
                    const assetData = currentTimestampData[assetIndex]
                    //iterate over the sources data for the asset
                    for (const assetSourceData of assetData) {
                        if (assetSourceData.ts * 1000 !== currentIterationTimestamp) {
                            logger.warn(`Data for source ${assetSourceData.source}, timestamp ${currentTimestamp}, assetIndex ${assetIndex}, not matching timestamp`)
                            continue
                        }
                    }
                }

                //push the data to verified data
                const tradeDataItem = this.__trades.push(
                    container.settingsManager.appConfig.publicKey,
                    key,
                    assetsMap,
                    currentIterationTimestamp,
                    currentTimestampData
                )
                broadcastItems.get(key).set(currentIterationTimestamp, tradeDataItem)
                currentIterationTimestamp = currentIterationTimestamp - minute
            }
            //broadcast the data
            nodesManager.broadcast(getPriceSyncMessage(broadcastItems))

            logger.trace(`Pushed trades data for source ${source}, base asset ${baseAsset}, from ${from}, to ${from + (count - 1) * minute}`)
            //add the current node to the list of nodes that have the data
            timestampSync.add(container.settingsManager.appConfig.publicKey)
        } catch (err) {
            logger.error({err}, `Error loading prices for source ${assetsMap.source} and base asset ${assetsMap.baseAsset}`)
            timestampSync?.reject(err)
        }
    }

    /**
     * Load trades data
     * @param {[string]} key - key to load
     * @param {number} timestamp - timestamp
     * @returns {Promise}
     */
    loadTradesData() {
        const assetsMaps = getAssetsMap()
        const promises = []
        for (const assetsMap of assetsMaps)
            promises.push(this.loadTradesDataForSource(assetsMap))
        return Promise.all(promises)
    }

    async getTradesData(source, baseAsset, assets, timestamp) {
        const key = formatSourceAssetKey(source, baseAsset)
        //ensure we have latest data
        const {tradesTimestamp} = getCurrentTimestampInfo()
        if (this.__trades.getLastTimestamp(key) < tradesTimestamp)
            await this.__getOrAddTimestampSync(key, tradesTimestamp)
                .readyPromise
                .catch(err => logger.error({err}, `Error getting pending trades data for key ${key}, timestamp ${tradesTimestamp}`))
        return this.__trades.getTradesData(key, timestamp, assets)
    }
}

module.exports = TradesManager