const {getOracleContractState, ContractTypes} = require('@reflector/reflector-shared')
const {getMedianPrice, getVWAP, getPreciseValue, calcCrossPrice, getAveragePrice} = require('../../utils/price-utils')
const logger = require('../../logger')
const container = require('../container')

/**
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 */

/**
 * @param {TimestampTradeData} tradesData - trades data
 * @param {number} decimals - decimals
 * @param {BigInt[]} prevPrices - previous prices
 * @returns {BigInt[]}
 */
function calcPrice(tradesData, decimals, prevPrices) {
    const prices = Array(tradesData.length).fill(0n)
    for (let i = 0; i < tradesData.length; i++) {
        const assetTradesData = tradesData[i] || []
        const assetPrices = assetTradesData.map(td => {
            if (td.type === 'price')
                return getAveragePrice(td.sum, td.entries, decimals)
            else
                return getVWAP(td.volume, td.quoteVolume, decimals)
        })
        prices[i] = getMedianPrice(assetPrices) || prevPrices[i] || 0n
    }

    return prices
}

const minute = 60 * 1000

/**
 * @param {string} contractId - source
 * @param {number} timestamp - current timestamp
 * @returns {Promise<BigInt[]>}
 */
async function getPricesForContract(contractId, timestamp) {
    const {settingsManager, tradesManager} = container
    const contract = settingsManager.getContractConfig(contractId)
    if (!contract)
        throw new Error(`Contract ${contractId} not found`)
    if (contract.type !== ContractTypes.ORACLE)
        throw new Error(`Contract ${contractId} is not an oracle contract`)

    const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
    //get contract state
    const contractState = await getOracleContractState(contractId, sorobanRpc)
    //get assets for the contract
    const assets = settingsManager.getAssets(contract.contractId, true)
    const prevPrices = [...contractState.prices, ...Array(assets.length - contractState.prices.length).fill(0n)]

    logger.trace({msg: `Previous prices for contract ${contractId}, timestamp: ${contractState.lastTimestamp}`, prevPrices})

    //start of the current timeframe
    let currentTradesDataTimestamp = timestamp

    //get trades data
    const totalTradesData = Array(assets.length).fill(0n).map(() => new Map())
    while (currentTradesDataTimestamp < timestamp + contract.timeframe) {
        //load trades data for the current timestamp
        const tradesData = await tradesManager.getTradesData(
            contract.dataSource,
            contract.baseAsset,
            assets,
            currentTradesDataTimestamp
        )
        if (!tradesData)
            logger.debug(`Trades data not found for timestamp ${currentTradesDataTimestamp} for contract ${contractId}. Source: ${contract.dataSource}, base asset: ${contract.baseAsset.code}`)
        else //aggregate trades data
            for (let i = 0; i < assets.length; i++) {
                if (tradesData.length <= i) //if the asset was added recently, we don't have trades data for it yet
                    break
                //get total trades data for the asset
                const totalAssetTradesData = totalTradesData[i]
                //get trades data for the asset
                const assetTradeData = tradesData[i]
                //iterate over sources
                for (const sourceTradeData of assetTradeData) {
                    let sourceTotalTradesData = totalAssetTradesData.get(sourceTradeData.source)
                    if (!sourceTotalTradesData) {
                        sourceTotalTradesData = sourceTradeData.type === 'price' ? {sum: 0n, entries: 0, type: 'price'} : {volume: 0n, quoteVolume: 0n}
                        totalAssetTradesData.set(sourceTradeData.source, sourceTotalTradesData)
                    }
                    if (sourceTradeData.ts * 1000 !== currentTradesDataTimestamp) {
                        logger.warn(`Trades data for source ${sourceTradeData.source} not found for timestamp ${currentTradesDataTimestamp} for contract ${contractId}. Source: ${contract.dataSource}, base asset: ${contract.baseAsset.code}`)
                        continue
                    }
                    if (sourceTotalTradesData.type === 'price') {
                        sourceTotalTradesData.sum += sourceTradeData.price
                        sourceTotalTradesData.entries++
                    } else {
                        sourceTotalTradesData.volume += sourceTradeData.volume
                        sourceTotalTradesData.quoteVolume += sourceTradeData.quoteVolume
                    }
                }
            }
        currentTradesDataTimestamp += minute
    }
    const tradesData = totalTradesData.map(v => [...v.values()])
    if (!tradesData.some(v => v.length !== 0)) //if all volumes are empty
        throw new Error(`Trades data not found for contract ${contractId} for timestamp ${timestamp}`)
    //compute price
    const prices = calcPrice(tradesData, settingsManager.getDecimals(contractId), prevPrices)
    return prices
}

async function getPriceForAsset(source, baseAsset, asset, timestamp) {
    const {tradesManager, settingsManager} = container
    const tradesData = await tradesManager.getTradesData(source, baseAsset, [asset], timestamp)
    const decimals = settingsManager.getDecimals()
    if (!tradesData || tradesData.length === 0 || tradesData[0] === null) {
        logger.warn(`Volume for asset ${asset.toString()} not found for timestamp ${timestamp}. Source: ${source}, base asset: ${baseAsset}`)
        return {price: 0n, decimals}
    }
    const price = calcPrice(tradesData, decimals, [0n])[0]
    if (price === 0n)
        logger.debug(`Price for asset ${asset.toString()} at ${timestamp}: ${price}`)
    return {price, decimals}
}

async function getPricesForPair(baseSource, baseAsset, quoteSource, quoteAsset, timestamp) {
    const {settingsManager} = container
    const decimals = settingsManager.getDecimals()
    //get default assets for the sources
    const defaultBaseAsset = settingsManager.getBaseAsset(baseSource)
    const defaultQuoteAsset = settingsManager.getBaseAsset(quoteSource)

    const {networkPassphrase} = container.settingsManager.getBlockchainConnectorSettings()

    const isBaseAsset = (baseAsset, asset) => baseAsset.equals(asset, networkPassphrase)

    const baseAssetPrice = isBaseAsset(defaultBaseAsset, baseAsset)
        ? {price: getPreciseValue(1n, decimals), decimals}
        : await getPriceForAsset(baseSource, defaultBaseAsset, baseAsset, timestamp)

    const quoteAssetPrice = isBaseAsset(defaultQuoteAsset, quoteAsset)
        ? {price: getPreciseValue(1n, decimals), decimals}
        : await getPriceForAsset(quoteSource, defaultQuoteAsset, quoteAsset, timestamp)

    const price = calcCrossPrice(quoteAssetPrice.price, baseAssetPrice.price, decimals)
    if (price === 0n)
        logger.debug(`Price for pair ${baseAsset.toString()}/${quoteAsset.toString()} at ${timestamp} is zero`)
    return {price, decimals}
}

module.exports = {
    getPricesForContract,
    getPricesForPair
}