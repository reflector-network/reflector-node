const {getOracleContractState, ContractTypes, getMajority} = require('@reflector/reflector-shared')
const {getMedianPrice, getVWAP, getPreciseValue, calcCrossPrice, getAveragePrice} = require('../../utils/price-utils')
const logger = require('../../logger')
const container = require('../container')

/**
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 */

const lastPriceConsensus = new Map()

function updatePriceConsensusTimestamp(contractId, priceData, timestamp) {
    let assets = lastPriceConsensus.get(contractId)
    if (!assets) {
        assets = []
        lastPriceConsensus.set(contractId, assets)
    }
    for (let i = 0; i < priceData.length; i++) {
        const assetPriceData = priceData[i]
        //if the asset price data is not empty or the asset is not in the list, update the timestamp
        if (assetPriceData?.length < 1 && assets[i] !== undefined) {
            logger.trace(`Price consensus for contract ${contractId} for asset ${i}: ${timestamp} is not updated`)
            continue
        }
        assets[i] = timestamp
    }
    logger.trace(`Price consensus for contract ${contractId}: ${assets.map(a => a.toString())}`)
    return assets
}

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
    const {settingsManager} = container
    const contract = settingsManager.getContractConfig(contractId)
    if (!contract)
        throw new Error(`Contract ${contractId} not found`)
    if (contract.type !== ContractTypes.ORACLE)
        throw new Error(`Contract ${contractId} is not an oracle contract`)

    const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
    //get contract state
    const contractStatePromise = getOracleContractState(contractId, sorobanRpc)
    //get assets for the contract
    const assets = settingsManager.getAssets(contract.contractId, true)

    //get trades data
    const concensusData = await getConcensusData(
        contract.dataSource,
        contract.baseAsset,
        assets,
        timestamp,
        contract.timeframe
    )
    //aggregate trades data
    const totalTradesData = Array(assets.length).fill(0n).map(() => new Map())
    for (const timestampData of concensusData) {
        for (let i = 0; i < assets.length; i++) {
            if (timestampData.length <= i) //if the asset was added recently, we don't have trades data for it yet
                break
            //get total trades data for the asset
            const totalAssetTradesData = totalTradesData[i]
            //get trades data for the asset
            const assetTradeData = timestampData[i]
            //iterate over sources
            for (const sourceTradeData of assetTradeData) {
                let sourceTotalTradesData = totalAssetTradesData.get(sourceTradeData.source)
                if (!sourceTotalTradesData) {
                    sourceTotalTradesData = sourceTradeData.type === 'price' ? {sum: 0n, entries: 0, type: 'price'} : {volume: 0n, quoteVolume: 0n}
                    totalAssetTradesData.set(sourceTradeData.source, sourceTotalTradesData)
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
    }
    const tradesData = totalTradesData.map(v => [...v.values()])
    if (!tradesData.some(v => v.length !== 0)) //if all volumes are empty
        throw new Error(`Trades data not found for contract ${contractId} for timestamp ${timestamp}`)

    //update price consensus timestamps
    const lastPriceConsensus = updatePriceConsensusTimestamp(contractId, tradesData, timestamp)

    //build prev prices
    const contractState = await contractStatePromise
    const prevPrices = Array(assets.length).fill(0n)
    for (let assetIndex = 0; assetIndex < prevPrices.length; assetIndex++) {
        if (!assets[assetIndex]) {
            logger.debug(`Asset ${assetIndex} not found for contract ${contractId}. Probably it has expired`)
            continue
        }
        //if price wasn't updated by consensus for more than 15 minutes, don't use previous price
        if (timestamp - lastPriceConsensus[assetIndex] > 15 * minute) {
            logger.warn(`Price consensus for asset ${assets[assetIndex].toString()} is too old: ${lastPriceConsensus[assetIndex] - timestamp}ms`)
            continue
        }
        prevPrices[assetIndex] = contractState.prices[assetIndex] || 0n
    }

    //compute price
    const prices = calcPrice(tradesData, settingsManager.getDecimals(contractId), prevPrices)
    logger.trace(`Prices for contract ${contractId} at ${timestamp}: ${prices.map(p => p.toString())}`)
    return prices
}

async function getPriceForAsset(source, baseAsset, asset, timestamp) {
    const {settingsManager} = container
    const tradesData = await getConcensusData(source, baseAsset, [asset], timestamp)
    const decimals = settingsManager.getDecimals()
    if (!tradesData || tradesData.length === 0 || tradesData[0] === null) {
        logger.warn(`Volume for asset ${asset.toString()} not found for timestamp ${timestamp}. Source: ${source}, base asset: ${baseAsset}`)
        return {price: 0n, decimals}
    }
    function normalizeTradesData(data) {
        return data.map(td => {
            if (td.type === 'price')
                return {...td, sum: td.price, entries: 1}
            return td
        })
    }
    const price = calcPrice(tradesData.map(normalizeTradesData), decimals, [0n])[0]
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

/**
 * @param {string} source - source of the data
 * @param {string} base - base asset
 * @param {string[]} assets - assets to get data for
 * @param {number} timestamp - timestamp to get data for
 * @param {number} timeframe - timeframe to get data for
 * @returns {Promise<TimestampTradeData[]>}
 */
async function getConcensusData(source, base, assets, timestamp, timeframe) {
    const {settingsManager, tradesManager} = container

    const majorityCount = getMajority(settingsManager.nodes.length)
    const currentPubkey = settingsManager.appConfig.publicKey

    const nodes = settingsManager.nodes.map(({pubkey}, index) => ({
        pubkey,
        mask: 1 << index
    }))

    const currentNodeMask = nodes.find(n => n.pubkey === currentPubkey)?.mask

    const isSameData = (a, b) =>
        a.type === b.type &&
      a.price === b.price &&
      a.quoteVolume === b.quoteVolume &&
      a.volume === b.volume

    let currentTimestamp = timestamp - timeframe
    const masks = new Map()
    const candidate = []

    //get trades data for the current timestamp
    while (currentTimestamp <= timestamp) {
        currentTimestamp += minute

        const tradesData = await tradesManager.getTradesData(
            source,
            base,
            assets,
            currentTimestamp
        )

        //skip if majority is not possible
        if (tradesData.size < majorityCount) {
            logger.debug(`No majority for ts ${currentTimestamp}, contract ${source}, base ${base.code}`)
            continue
        }

        //skip if no data for the current node
        const currentNodeData = tradesData.get(currentPubkey)
        if (!currentNodeData) {
            logger.debug(`Current node data missing for ts ${currentTimestamp}, contract ${source}`)
            continue
        }

        //iterate over the current node data and check if it matches with the other nodes
        for (const assetData of currentNodeData) {
            for (let sourceIndex = assetData.length - 1; sourceIndex >= 0; sourceIndex--) {
                const sourceData = assetData[sourceIndex]
                sourceData.nodes = currentNodeMask

                let matchingNodesCount = 1
                for (const {pubkey, mask} of nodes) {
                    if (pubkey === currentPubkey)
                        continue

                    const nodeData = tradesData
                        .get(pubkey)?.[currentNodeData.indexOf(assetData)]
                        ?.find(d => d.source === sourceData.source)

                    //skip if no data for the node or if the data doesn't match
                    if (!nodeData || !isSameData(nodeData, sourceData))
                        continue

                    //add the node mask to the source data nodes
                    sourceData.nodes |= mask
                    //increment the matching nodes count
                    matchingNodesCount++
                }

                //skip if the majority is not reached and remove the asset data
                if (matchingNodesCount < majorityCount) {
                    assetData.splice(sourceIndex, 1)
                    continue
                }

                //increment the mask count for the source data nodes
                masks.set(sourceData.nodes, (masks.get(sourceData.nodes) ?? 0) + 1)
            }
        }
        //push the current node data to the candidate list
        candidate.push(currentNodeData)
    }

    if (masks.size === 0) {
        logger.debug(`No matching nodes found for contract ${source}, base ${base.code}`)
        return []
    }
    const [bestMask] = [...masks.entries()].sort((a, b) => b[1] - a[1])[0]

    for (const assetList of candidate) {
        for (const assetData of assetList) {
            for (let i = assetData.length - 1; i >= 0; i--) {
                //remove the asset data if the nodes don't match with the best mask
                if ((assetData[i].nodes & bestMask) !== bestMask)
                    assetData.splice(i, 1)
            }
        }
    }
    return candidate
}


module.exports = {
    getPricesForContract,
    getPricesForPair,
    getConcensusData
}