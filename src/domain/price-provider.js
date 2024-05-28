const {getPrices: getExchangePrices} = require('@reflector/reflector-exchanges-connector')
const {fetchQuotes} = require('@reflector/reflector-coinmarketcap-connector')
const {aggregateTrades} = require('@reflector/reflector-db-connector')
const dataSourcesManager = require('../domain/data-sources-manager')
const DataSourceTypes = require('../models/data-source-types')

/**
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

/**
 * @param {string} sourceName - source name
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets
 * @param {number} decimals - decimals
 * @param {number} from - from Unix timestamp
 * @param {number} period - period in seconds
 * @param {BigInt[]} prevPrices - previous prices
 * @return {Promise<BigInt[]>}
 */
async function getPrices(sourceName, baseAsset, assets, decimals, from, period, prevPrices) {
    if (!dataSourcesManager.has(sourceName))
        throw new Error(`Data source ${sourceName} not found`)
    const dataSource = dataSourcesManager.get(sourceName)
    switch (dataSource.type) {
        case DataSourceTypes.API:
            return await getApiPrices(dataSource, baseAsset, assets, decimals, from, period, prevPrices)
        case DataSourceTypes.DB: {
            const {dbConnector} = dataSource
            const prices = await aggregateTrades({db: dbConnector, baseAsset, assets, decimals, from, period, prevPrices})
            if (prices && prices.length > 0)
                return prices
            return prevPrices
        }
        default:
            throw new Error(`Data source ${sourceName} not supported`)
    }
}

async function getApiPrices(dataSource, baseAsset, assets, decimals, from, period, prevPrices) {
    switch (dataSource.name) {
        case 'exchanges': {
            const prices = await getExchangePrices(
                assets.map(asset => asset.code),
                baseAsset.code,
                from,
                period,
                decimals
            )
            if (prices && prices.length === assets.length)
                return prices
            return prevPrices
        }
        case 'coinmarketcap': {
            const {secret} = dataSource
            const quotesData = await fetchQuotes(assets.map(a => a.code), decimals, secret)
            if (quotesData && quotesData.prices && quotesData.prices.length === assets.length)
                return quotesData.prices
            return prevPrices
        }
        default:
            throw new Error(`Data source ${dataSource.name} not supported`)
    }
}

module.exports = {getPrices}