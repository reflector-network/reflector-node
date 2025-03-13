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
const AssetMap = require('./asset-map')

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
 * @returns {AssetMap[]}
 */
function getAssetsMap() {
    const {settingsManager} = container
    const oracleContracts = [...settingsManager.config.contracts.values()]
        .filter(c => c.type === ContractTypes.ORACLE)

    /**@type {Map<string,AssetMap>} */
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
        am = new AssetMap(source, baseAsset)
        assetsMap.set(key, am)
    }
    am.push(assets)
}

function formatSourceAssetKey(source, baseAsset) {
    return `${source}_${baseAsset.code}`
}

/**
 * @param {AggregatedTradeData} data - aggregated trade data
 * @param {boolean} toString - direction of conversion
 * @returns {AggregatedTradeData}
 */
function normalizeTradeData(data, toString) {
    return data.map(timestampTradeData =>
        timestampTradeData.map(assetTradeData =>
            assetTradeData.map(tradeData => ({
                ...tradeData,
                ...(tradeData.type !== 'price'
                    ? {
                        volume: toString ? tradeData.volume.toString() : BigInt(tradeData.volume),
                        quoteVolume: toString ? tradeData.quoteVolume.toString() : BigInt(tradeData.quoteVolume)
                    }
                    : {
                        price: toString ? tradeData.price.toString() : BigInt(tradeData.price)
                    })
            }))
        )
    )
}

function getPriceSyncMessage(key, timestamp, trades) {
    return {
        type: MessageTypes.PRICE_SYNC,
        data: {
            key,
            timestamp,
            trades: normalizeTradeData(trades, true)
        }
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

class PendingTradesData {
    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     */
    constructor(key, timestamp) {
        this.key = key
        this.timestamp = timestamp
        this.isProcessed = false

        const currentTimestamp = timestamp + minute //trades data timestamp, basically current normalized timestamp - 1 minute, so add 1 minute to the timestamp
        this.maxTime = currentTimestamp
            + container.settingsManager.appConfig.dbSyncDelay //add db sync delay
            + 35 * 1000 //30 seconds for trades data fetching, and 5 seconds for the nodes sync

        if (this.maxTime < Date.now())
            throw new Error(`Timestamp ${timestamp} is too old to process. Max time: ${this.maxTime}, current time: ${Date.now()}`)

        this.majorityPromise = new Promise((resolve, reject) => {
            let isSettled = false
            const timeout = this.maxTime - Date.now()
            const timeoutId = setTimeout(() => {
                logger.debug(`Pending trades data timed out. Key: ${this.key}, timestamp: ${this.timestamp}, maxTime: ${this.maxTime}, isProcessed: ${this.isProcessed}, pubkeys: ${[...this.__pendingData.keys()].join(',')}, current time: ${Math.floor(Date.now() / 1000)}`)

                if (this.isProcessed) //if the data is already processed
                    return
                else if (this.__isReadyToProcess(true)) { //if we have majority
                    logger.debug(`Processing pending trades data on timeout. Key: ${this.key}.`)
                    this.__process()
                    return
                }

                this.reject(new Error('Pending trades data timed out'))
            }, timeout)

            this.resolve = (value) => {
                if (!isSettled) {
                    isSettled = true
                    clearTimeout(timeoutId)
                    resolve(value)
                }
            }

            this.reject = (reason) => {
                if (!isSettled) {
                    isSettled = true
                    clearTimeout(timeoutId)
                    reject(reason)
                }
            }
        })

        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = () => {
                logger.trace(`Pending trades data ready. Key: ${this.key}, timestamp: ${this.timestamp}, maxTime: ${this.maxTime}, pubkeys: ${[...this.__pendingData.keys()].join(',')}, current time: ${Math.floor(Date.now() / 1000)}`)
                resolve()
            }
            this.readyReject = (err) => {
                logger.error({err}, `Error processing pending trades data. Key: ${this.key}, timestamp: ${this.timestamp}, maxTime: ${this.maxTime}, pubkeys: ${[...this.__pendingData.keys()].join(',')}, current time: ${Math.floor(Date.now() / 1000)}`)
                reject(err)
            }
        })
    }

    __pendingData = new Map()

    add(pubkey, data) {
        this.__pendingData.set(pubkey, data)
        if (this.__isReadyToProcess()) { //if we have majority
            logger.debug(`Processing pending trades data. Key: ${this.key}.`)
            this.__process()
        }
    }

    __isReadyToProcess(majorityEnought = false) {
        const currentNodePubkey = container.settingsManager.appConfig.publicKey
        return !this.isProcessed //if not processed yet
            && this.__pendingData.has(currentNodePubkey) //if the current node is in the list
            && (majorityEnought || (this.__pendingData.size - 1) >= nodesManager.getConnectedNodes().length) //if we have all possible nodes data or we majority is enough
            && hasMajority(container.settingsManager.config.nodes.size, this.__pendingData.size) //if we have majority
    }


    __process() {
        this.isProcessed = true
        //reverse the data to have the latest data first
        //iterate over the pending data from current node. We will not validate the data from other nodes if it not present in the current node data
        const currentNodeData = this.__pendingData
            .get(container.settingsManager.appConfig.publicKey)

        //get all nodes data except the current node
        const allNodesData = [...this.__pendingData.entries()]
            .filter(([pubkey]) => pubkey !== container.settingsManager.appConfig.publicKey)

        const verifiedData = new Map()

        //iterate over the data from the current node, starting from the latest timestamp
        let currentTimestamp = this.timestamp
        //push volumes to the cache
        for (let j = currentNodeData.length - 1; j >= 0; j--) {
            const currentTimestampMajorityData = []
            const currentTimestampData = currentNodeData[j]
            for (let assetIndex = 0; assetIndex < currentTimestampData.length; assetIndex++) {
                const assetData = currentTimestampData[assetIndex]
                const currentAssetMajorityData = []
                currentTimestampMajorityData.push(currentAssetMajorityData)
                //iterate over the sources data for the asset
                for (const assetSourceData of assetData) {
                    let verifiedCount = 1 //count the current node as verified

                    //find the data for the source in the other nodes data
                    for (const nodeData of allNodesData) {
                        const [pubkey, nodeDataValue] = nodeData
                        const nodeAssetSourceData = nodeDataValue[j]?.[assetIndex]?.find(d => d.source === assetSourceData.source)
                        if (!nodeAssetSourceData) {
                            logger.trace(`Data for source ${assetSourceData.source}, timestamp ${currentTimestamp}, assetIndex ${assetIndex}, not found in node ${pubkey}`)
                            continue
                        } else if (
                            nodeAssetSourceData.type !== assetSourceData.type
                            || nodeAssetSourceData.price !== assetSourceData.price
                            || nodeAssetSourceData.quoteVolume !== assetSourceData.quoteVolume
                            || nodeAssetSourceData.volume !== assetSourceData.volume
                            || nodeAssetSourceData.ts !== assetSourceData.ts
                        ) {
                            logger.trace(`Data for source ${assetSourceData.source}, timestamp ${currentTimestamp}, assetIndex ${assetIndex}, not matching in node ${pubkey}`)
                            continue
                        }
                        verifiedCount++
                    }
                    if (assetSourceData.ts * 1000 !== currentTimestamp) {
                        logger.warn(`Data for source ${assetSourceData.source}, timestamp ${currentTimestamp}, assetIndex ${assetIndex}, not matching timestamp`)
                        continue
                    }
                    //if we have majority, push the data to the cache, otherwise skip it
                    if (!hasMajority(container.settingsManager.config.nodes.size, verifiedCount)) {
                        logger.info(`Data for source ${assetSourceData.source}, timestamp ${currentTimestamp}, assetIndex ${assetIndex}, not verified`)
                        continue
                    }
                    currentAssetMajorityData.push(assetSourceData)
                }
            }

            //push the data to verified data
            verifiedData.set(currentTimestamp, currentTimestampMajorityData)
            currentTimestamp = currentTimestamp - minute
        }
        //logger.debug(`Verified data for key ${this.key}, timestamp ${this.timestamp}`)
        //logger.debug(normalizeTradeData([...verifiedData.values()], true))
        //resolve the promise
        this.resolve(verifiedData)
    }
}

class TradesManager {

    constructor() {
        this.__clearPendingTradesDataWorker()
    }

    __clearPendingTradesDataWorker() {
        const twoMinutes = 2 * minute
        setTimeout(() => {
            const currentTimestamp = normalizeTimestamp(Date.now(), minute)
            for (const [timestamp] of this.__pendingTradesData) {
                if (timestamp < currentTimestamp - twoMinutes) {
                    logger.debug(`Clearing pending trades data for timestamp ${timestamp}`)
                    this.__pendingTradesData.delete(timestamp)
                }
            }
            this.__clearPendingTradesDataWorker()
        }, twoMinutes)
    }

    trades = new TradesCache()

    __pendingTradesData = new Map()

    /**
     * @param {string} pubkey - public key
     * @param {{timestamp: number, key: string, trades: any}} priceData - price data
     * @returns {PendingTradesData}
     */
    addPendingTradesData(pubkey, priceData) {
        const {timestamp, key, trades} = priceData || {}
        if (!key)
            throw new Error('Key is required')
        if (!timestamp)
            throw new Error('Timestamp is required')
        if (!trades)
            throw new Error('Trades data is required')

        const pendingData = this.__getOrAddPendingTradesData(key, timestamp)
        pendingData.add(pubkey, normalizeTradeData(trades, false))

        return pendingData
    }

    /**
     * @param {string} pubKey - public key
     * @returns {void}
     */
    sendPendingTradesData(pubKey) {
        const currentNodePubkey = container.settingsManager.appConfig.publicKey
        for (const [timestamp, timestampData] of this.__pendingTradesData) {
            for (const [key, pendingData] of timestampData) {
                if (pendingData.isProcessed)
                    continue
                const currentNodeData = pendingData.__pendingData.get(currentNodePubkey)
                if (currentNodeData) {
                    nodesManager.sendTo(pubKey, getPriceSyncMessage(key, timestamp, currentNodeData))
                }
            }
        }
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @returns {PendingTradesData}
     */
    __getOrAddPendingTradesData(key, timestamp) {
        let timestampPendingData = this.__pendingTradesData.get(timestamp)
        if (!timestampPendingData) {
            if (timestamp % minute !== 0)
                throw new Error(`Timestamp ${timestamp} is invalid`)
            if (normalizeTimestamp(Date.now(), minute) - timestamp > 2 * minute)
                throw new Error(`Timestamp ${timestamp} is too old`)
            timestampPendingData = new Map()
            this.__pendingTradesData.set(timestamp, timestampPendingData)
        }
        let pendingData = timestampPendingData.get(key)
        if (!pendingData) {
            pendingData = new PendingTradesData(key, timestamp)
            timestampPendingData.set(key, pendingData)
        }
        return pendingData
    }

    /**
     * @param {AssetMap} assetMap - asset map
     */
    async loadTradesDataForSource(assetMap) {
        /**@type {PendingTradesData} */
        let pendingTradesData = null
        try {
            const {currentTimestamp, tradesTimestamp} = getCurrentTimestampInfo()
            logger.trace({assetMap: assetMap.toPlainObject()}, `Loading trades data for the asset map at timestamp ${tradesTimestamp}, current timestamp ${currentTimestamp}`)

            const {source, baseAsset} = assetMap

            const key = formatSourceAssetKey(source, baseAsset)
            const lastTimestamp = this.trades.getLastTimestamp(key)

            const count = getSampleSize(lastTimestamp, tradesTimestamp)
            //if count is greater than 0, then we need to load volumes
            if (count === 0) {
                logger.trace(`Skipping trades loading for source ${source}, base asset ${baseAsset}, timestamp ${tradesTimestamp}, last timestamp ${lastTimestamp}, current timestamp ${currentTimestamp}`)
                return
            }

            pendingTradesData = this.__getOrAddPendingTradesData(key, tradesTimestamp)

            const from = tradesTimestamp - ((count - 1) * minute)

            const currentNodePubkey = container.settingsManager.appConfig.publicKey

            logger.trace(`Loading trades data for source ${source}, base asset ${baseAsset}, timestamp ${tradesTimestamp}, from ${from}, count ${count}`)

            const dataSource = dataSourcesManager.get(source)

            //normalize assets
            const normalizedAssets = assetMap.assets.map(a => a.asset)

            //load the data
            const tradesPromise = loadTradesData(dataSource, baseAsset, normalizedAssets, from, count)
                .then(tradesData => {
                    //broadcast the data to the nodes
                    nodesManager.broadcast(getPriceSyncMessage(key, tradesTimestamp, tradesData))

                    //add the data to the pending data
                    pendingTradesData.add(currentNodePubkey, tradesData)
                })

            //wait for the data to loaded and approved by the majority
            await Promise.all([pendingTradesData.majorityPromise, tradesPromise])

            //get the verified data
            const verifiedData = await pendingTradesData.majorityPromise

            //push the data to the cache
            for (const [ts, tsData] of verifiedData) {
                this.trades.push(key, assetMap, ts, tsData)
            }

            //resolve the current timestamp
            pendingTradesData.readyResolve()

            logger.trace(`Pushed trades data for source ${source}, base asset ${baseAsset}, from ${from}, to ${from + (count - 1) * minute}`)
        } catch (err) {
            logger.error({err}, `Error loading prices for source ${assetMap.source} and base asset ${assetMap.baseAsset}`)
            pendingTradesData?.readyReject(err)
        }
    }

    /**
     * Load trades data
     * @param {[string]} key - key to load
     * @param {number} timestamp - timestamp
     * @returns {Promise}
     */
    loadTradesData() {
        const assetMaps = getAssetsMap()
        const promises = []
        for (const assetMap of assetMaps)
            promises.push(this.loadTradesDataForSource(assetMap))
        return Promise.all(promises)
    }

    async getTradesData(source, baseAsset, assets, timestamp) {
        const key = formatSourceAssetKey(source, baseAsset)
        //ensure we have latest data
        const {tradesTimestamp} = getCurrentTimestampInfo()
        if (this.trades.getLastTimestamp() < tradesTimestamp)
            await this.__getOrAddPendingTradesData(key, tradesTimestamp)
                .readyPromise
                .catch(err => logger.error({err}, `Error getting pending trades data for key ${key}, timestamp ${tradesTimestamp}`))
        return this.trades.getTradesData(key, timestamp, assets)
    }
}

module.exports = TradesManager