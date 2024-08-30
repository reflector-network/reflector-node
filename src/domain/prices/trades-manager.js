const {normalizeTimestamp, Asset, AssetType} = require('@reflector/reflector-shared')
const {getTradesData} = require('@reflector/reflector-exchanges-connector')
const {aggregateTrades} = require('@reflector/reflector-db-connector')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const DataSourceTypes = require('../../models/data-source-types')
const dataSourcesManager = require('../data-sources-manager')
const logger = require('../../logger')
const container = require('../container')
const {getAllSubscriptions} = require('../subscriptions/subscriptions-data-manager')
const TradesCache = require('./trades-cache')
const AssetMap = require('./asset-map')

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

function getCount(lastTimestemp, targetTimestamp) {
    if (lastTimestemp >= targetTimestamp) {
        return 0
    }
    const computedCount = (targetTimestamp - lastTimestemp) / minute
    return Math.min(computedCount, maxLimit)
}

const minute = 60 * 1000
const maxLimit = 15

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
    switch (dataSource.type) {
        case DataSourceTypes.API:
            return loadApiTradesData(dataSource, baseAsset, assets, from, count)
        case DataSourceTypes.DB:
            return loadDbTradesData(dataSource, baseAsset, assets, from, count)
        default:
            throw new Error(`Data source ${dataSource.type} not supported`)
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
async function loadApiTradesData(dataSource, baseAsset, assets, from, count) {
    switch (dataSource.name) {
        case 'exchanges': {
            const tradesData = await getTradesData(
                assets.map(asset => asset.code),
                baseAsset.code,
                from,
                minute / 1000,
                count
            )
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
    const {dbConnector} = dataSource
    const start = Date.now()
    const tradesData = await aggregateTrades({db: dbConnector, baseAsset, assets, from, period: minute, limit: count})
    logger.info(`Loaded ${tradesData.length} trades data in ${Date.now() - start} ms`)

    //normalize data to the same format as API data
    for (let tsIndex = 0; tsIndex < tradesData.length; tsIndex++) {
        const tsTrades = tradesData[tsIndex]
        for (let assetIndex = 0; assetIndex < tsTrades.length; assetIndex++) {
            const {volume, quoteVolume} = tsTrades[assetIndex]
            tsTrades[assetIndex] = [{volume, quoteVolume, source: dataSource.name, ts: from + tsIndex * minute / 1000}]
        }
    }
    return tradesData
}

const baseExchangesAsset = new Asset(AssetType.OTHER, 'USD')
const baseStellarAsset = new Asset(AssetType.STELLAR, 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')

function getSourceDefaultBaseAsset(source) {
    switch (source) {
        case 'exchanges':
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

    /**@type {Object.<string, AssetMap>} */
    const assetsMap = {}

    //add asset to the map function
    const addAssetToMap = (source, baseAsset, assets) => {
        const key = getSourcePricesKey(source, baseAsset)
        if (!assetsMap.hasOwnProperty(key)) //if the key doesn't exist, create a new map
            assetsMap[key] = new AssetMap(source, baseAsset)
        assetsMap[key].push(assets)
    }

    //push all oracle assets to the map
    for (const contract of oracleContracts.sort((a, b) => a.contractId.localeCompare(b.contractId)))
        addAssetToMap(contract.dataSource, contract.baseAsset, settingsManager.getAssets(contract.contractId, true))

    //push all subscriptions assets to the map
    const allSubscriptions = getAllSubscriptions()

    //push all subscriptions assets to the map
    for (const subscription of allSubscriptions) {
        const baseAsset = getSourceDefaultBaseAsset(subscription.base.source)
        const quoteBaseAsset = getSourceDefaultBaseAsset(subscription.quote.source)
        if (!(baseAsset && quoteBaseAsset)) { //if the source is not supported
            logger.debug(`Subscription ${subscription.id} source(s) not supported`)
            continue
        }

        if (!baseAsset.equals(subscription.base.asset)) //if the base asset is not the same as the default one
            addAssetToMap(subscription.base.source, baseAsset, [subscription.base.asset])

        if (!quoteBaseAsset.equals(subscription.quote.asset)) //if the quote asset is not the same as the default one
            addAssetToMap(subscription.quote.source, quoteBaseAsset, [subscription.quote.asset])
    }
    return Object.values(assetsMap)
}

function getSourcePricesKey(source, baseAsset) {
    return `${source}_${baseAsset.code}`
}

class TradesManager {

    trades = new TradesCache()

    /**
     * @param {AssetMap} assetMap - asset map
     * @param {number} timestamp - timestamp
     */
    async loadTradesDataForSource(assetMap, timestamp) {
        try {
            const currentNormalizedTimestamp = normalizeTimestamp(Date.now(), minute)
            logger.trace({assetMap: assetMap.toPlainObject()}, `Loading trades data for the asset map at timestamp ${timestamp}. Current timestamp ${currentNormalizedTimestamp}`)
            if (timestamp % minute !== 0) {
                throw new Error('Timestamp should be whole minutes')
            } else if (timestamp >= currentNormalizedTimestamp) {
                throw new Error('Timestamp should be less than current time')
            } else if (timestamp < currentNormalizedTimestamp - minute * maxLimit) {
                throw new Error('Timestamp should be within last 60 minutes')
            }

            const {source, assets, baseAsset} = assetMap

            const key = getSourcePricesKey(source, baseAsset)
            const lastTimestamp = this.trades.getLastTimestamp(key)

            const count = getCount(lastTimestamp, timestamp)
            //if count is greater than 0, then we need to load volumes
            if (count === 0) {
                logger.trace(`No need to load trades data for source ${source}, base asset ${baseAsset}, timestamp ${timestamp}`)
                return
            }

            const from = timestamp - ((count - 1) * minute)

            logger.trace(`Loading trades data for source ${source}, base asset ${baseAsset}, timestamp ${timestamp}, from ${from}, count ${count}`)

            const dataSource = dataSourcesManager.get(source)
            //load volumes
            const normalizedAssets = Object.values(assets).map(a => a.asset)
            const tradesData = await loadTradesData(dataSource, baseAsset, normalizedAssets, from, count)
            //push volumes to the cache
            for (let j = 0; j < tradesData.length; j++) {
                const currentTimestamp = from + j * minute
                this.trades.push(key, assetMap, currentTimestamp, tradesData[j])
            }
            logger.trace(`Pushed trades data for source ${source}, base asset ${baseAsset}, from ${from}, to ${from + (count - 1) * minute}`)
        } catch (err) {
            logger.error({err}, `Error loading prices for source ${assetMap.source} and base asset ${assetMap.baseAsset}`)
        }
    }

    /**
     * @param {number} timestamp - timestamp in milliseconds
     * @returns {Promise}
     */
    loadTradesData(timestamp) {
        if (this.__loadTradesPromise)
            return this.__loadTradesPromise
        const assetMaps = getAssetsMap()
        const promises = []
        for (const assetMap of assetMaps) {
            promises.push(this.loadTradesDataForSource(assetMap, timestamp))
        }
        this.__loadTradesPromise = Promise.all(promises)
            .then(() => {
                this.__loadTradesPromise = null
            })

        return this.__loadTradesPromise
    }

    async getTradesData(source, baseAsset, assets, timestamp) {
        const key = getSourcePricesKey(source, baseAsset)
        let attempts = 3
        while (attempts-- > 0) {
            const lastTimestamp = this.trades.getLastTimestamp(key)
            if (lastTimestamp >= timestamp)
                break
            await this.loadTradesData(timestamp)
        }
        return this.trades.getTradesData(key, timestamp, assets)
    }
}

module.exports = TradesManager