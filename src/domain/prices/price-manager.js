const {getOracleContractState, Asset, AssetType} = require('@reflector/reflector-shared')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const {getMedianPrice, getVWAP, getPreciseValue, calcCrossPrice} = require('../../utils/price-utils')
const logger = require('../../logger')
const container = require('../container')

/**
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 */

/**
 * @param {TimestampTradeData} volumes - volumes
 * @param {number} decimals - decimals
 * @param {BigInt[]} prevPrices - previous prices
 * @returns {BigInt[]}
 */
function calcPrice(volumes, decimals, prevPrices) {
    const prices = Array(volumes.length).fill(0n)
    for (let i = 0; i < volumes.length; i++) {
        const assetVolumes = volumes[i] || []
        const vwaps = assetVolumes.map(v => getVWAP(v.volume, v.quoteVolume, decimals))
        prices[i] = getMedianPrice(vwaps) || prevPrices[i] || 0n
    }

    return prices
}

const minute = 60 * 1000

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

const defaultDecimals = 14

const defaultPrice = {price: getPreciseValue(1n, defaultDecimals), decimals: defaultDecimals}

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

    //start of the current timeframe
    let currentVolumeTimestamp = timestamp

    //make sure we have the latest trades data
    await tradesManager.loadTradesData(timestamp)

    //get volumes
    const totalVolumes = Array(assets.length).fill(0n).map(() => new Map())
    while (currentVolumeTimestamp <= timestamp) {
        //load volumes for the current timestamp
        const tradesData = await tradesManager.getTradesData(
            contract.dataSource,
            contract.baseAsset,
            assets,
            currentVolumeTimestamp
        )
        if (!tradesData)
            throw new Error(`Volumes not found for timestamp ${currentVolumeTimestamp} for contract ${contractId}. Source: ${contract.dataSource}, base asset: ${contract.baseAsset.code}`)
        //aggregate volumes
        for (let i = 0; i < assets.length; i++) {
            if (tradesData.length <= i) //if the asset was added recently, we don't have volumes for it yet
                break
            //get total volume for the asset
            const totalAssetVolumes = totalVolumes[i]
            //get volumes for the asset
            const assetTradeData = tradesData[i]
            //iterate over sources
            for (const sourceTradeData of assetTradeData) {
                let sourceTotalVolume = totalAssetVolumes.get(sourceTradeData.source)
                if (!sourceTotalVolume) {
                    sourceTotalVolume = {volume: 0n, quoteVolume: 0n}
                    totalAssetVolumes.set(sourceTradeData.source, sourceTotalVolume)
                }
                if (sourceTradeData.ts * 1000 !== currentVolumeTimestamp) {
                    logger.warn(`Volume for source ${sourceTradeData.source} not found for timestamp ${currentVolumeTimestamp} for contract ${contractId}. Source: ${contract.dataSource}, base asset: ${contract.baseAsset.code}`)
                    continue
                }
                sourceTotalVolume.volume += sourceTradeData.volume
                sourceTotalVolume.quoteVolume += sourceTradeData.quoteVolume
            }
        }
        currentVolumeTimestamp += minute
    }
    //compute price
    const prices = calcPrice(totalVolumes.map(v => [...v.values()]), contract.decimals, prevPrices)
    return prices
}

async function getPriceForAsset(source, baseAsset, asset, timestamp) {
    const {tradesManager} = container
    const tradesData = await tradesManager.getTradesData(source, baseAsset, [asset], timestamp)
    if (!tradesData || tradesData.length === 0) {
        logger.warn(`Volume for asset ${asset.toString()} not found for timestamp ${timestamp}. Source: ${source}, base asset: ${baseAsset}`)
        return defaultPrice
    }
    const price = calcPrice(tradesData, defaultDecimals, [0n])[0]
    if (price === 0n)
        logger.debug(`Price for asset ${asset.toString()} at ${timestamp}: ${price}`)
    return {price, decimals: defaultDecimals}
}

async function getPricesForPair(baseSource, baseAsset, quoteSource, quoteAsset, timestamp) {
    //get default assets for the sources
    const defaultBaseAsset = getSourceDefaultBaseAsset(baseSource)
    const defaultQuoteAsset = getSourceDefaultBaseAsset(quoteSource)

    const {networkPassphrase} = container.settingsManager.getBlockchainConnectorSettings()

    const isBaseAsset = (baseAsset, asset) => baseAsset.equals(asset, networkPassphrase)

    const baseAssetPrice = isBaseAsset(defaultBaseAsset, baseAsset)
        ? defaultPrice
        : await getPriceForAsset(baseSource, defaultBaseAsset, baseAsset, timestamp)

    const quoteAssetPrice = isBaseAsset(defaultQuoteAsset, quoteAsset)
        ? defaultPrice
        : await getPriceForAsset(quoteSource, defaultQuoteAsset, quoteAsset, timestamp)

    const price = calcCrossPrice(baseAssetPrice.price, quoteAssetPrice.price, defaultDecimals)
    if (price === 0n)
        logger.debug(`Price for pair ${baseAsset.toString()}/${quoteAsset.toString()} at ${timestamp}: ${price}`)
    return {price, decimals: defaultDecimals}
}

module.exports = {
    getPricesForContract,
    getPricesForPair
}