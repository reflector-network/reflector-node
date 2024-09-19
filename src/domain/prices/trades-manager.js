const {normalizeTimestamp, Asset, AssetType, ContractTypes} = require('@reflector/reflector-shared')
const {getTradesData} = require('@reflector/reflector-exchanges-connector')
const {aggregateTrades} = require('@reflector/reflector-db-connector')
const DataSourceTypes = require('../../models/data-source-types')
const dataSourcesManager = require('../data-sources-manager')
const logger = require('../../logger')
const container = require('../container')
const {getAllSubscriptions} = require('../subscriptions/subscriptions-data-manager')
const TradesCache = require('./trades-cache')
const AssetMap = require('./asset-map')

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
    const tradesData = await aggregateTrades({db: dbConnector, baseAsset, assets, from, period: minute, limit: count})

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

class TradesManager {

    trades = new TradesCache()

    /**
     * @param {AssetMap} assetMap - asset map
     */
    async loadTradesDataForSource(assetMap) {
        try {
            const currentNormalizedTimestamp = normalizeTimestamp(Date.now(), minute)
            const timestamp = currentNormalizedTimestamp - minute
            logger.trace({assetMap: assetMap.toPlainObject()}, `Loading trades data for the asset map at timestamp ${timestamp}, current timestamp ${currentNormalizedTimestamp}`)

            const {source, baseAsset} = assetMap

            const key = formatSourceAssetKey(source, baseAsset)
            const lastTimestamp = this.trades.getLastTimestamp(key)

            const count = getSampleSize(lastTimestamp, timestamp)
            //if count is greater than 0, then we need to load volumes
            if (count === 0) {
                logger.trace(`Skipping trades loading for source ${source}, base asset ${baseAsset}, timestamp ${timestamp}, last timestamp ${lastTimestamp}, current timestamp ${currentNormalizedTimestamp}`)
                return
            }

            const from = timestamp - ((count - 1) * minute)

            logger.trace(`Loading trades data for source ${source}, base asset ${baseAsset}, timestamp ${timestamp}, from ${from}, count ${count}`)

            const dataSource = dataSourcesManager.get(source)
            //load volumes
            const normalizedAssets = assetMap.assets.map(a => a.asset)
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
     * @returns {Promise}
     */
    loadTradesData() {
        if (this.__loadTradesPromise)
            return this.__loadTradesPromise
        const assetMaps = getAssetsMap()
        const promises = []
        for (const assetMap of assetMaps) {
            promises.push(this.loadTradesDataForSource(assetMap))
        }
        this.__loadTradesPromise = Promise.all(promises)
            .then(() => {
                this.__loadTradesPromise = null
            })

        return this.__loadTradesPromise
    }

    async getTradesData(source, baseAsset, assets, timestamp) {
        const key = formatSourceAssetKey(source, baseAsset)
        let attempts = 3
        while (attempts-- > 0) {
            const lastTimestamp = this.trades.getLastTimestamp(key)
            if (lastTimestamp >= timestamp)
                break
            await this.loadTradesData()
        }
        return this.trades.getTradesData(key, timestamp, assets)
    }
}

module.exports = TradesManager