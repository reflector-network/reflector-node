const {ContractTypes, getMajority, compareStrings} = require('@reflector/reflector-shared')
const {getMedianPrice, getVWAP, getPreciseValue, calcCrossPrice} = require('../../utils/price-utils')
const logger = require('../../logger')
const container = require('../container')
const {dissentLog} = require('./dissent-log')

/**
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

/**
 * @param {TimestampTradeData} tradesData - trades data
 * @param {number} decimals - decimals
 * @returns {BigInt[]}
 */
function calcPrice(tradesData, decimals) {
    const prices = Array(tradesData.length).fill(0n)
    for (let i = 0; i < tradesData.length; i++) {
        const assetTradesData = tradesData[i] || []
        const assetPrices = assetTradesData.map(td => getVWAP(td.volume, td.quoteVolume, decimals))
        prices[i] = getMedianPrice(assetPrices) || 0n
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
    if (contract.type !== ContractTypes.ORACLE && contract.type !== ContractTypes.ORACLE_BEAM)
        throw new Error(`Contract ${contractId} is not an oracle contract`)

    //get assets for the contract
    const assets = settingsManager.getAssets(contract.contractId, timestamp)

    //get trades data
    const concensusData = await getConcensusData(
        contract.dataSource,
        contract.baseAsset,
        assets,
        timestamp,
        contract.timeframe
    )
    //aggregate trades data
    const tradesData = aggrTradesData(assets.length, concensusData)
    if (!tradesData.some(v => v.length !== 0)) //if all volumes are empty
        throw new Error(`Trades data not found for contract ${contractId} for timestamp ${timestamp}`)

    //compute price
    const prices = calcPrice(tradesData, settingsManager.getDecimals(contractId))
    logger.trace({msg: 'Prices for data', contract: contractId, timestamp, prices: prices.map(p => p.toString())})
    return prices
}

/**
 *
 * @param {number} assetsLength - total number of assets
 * @param {TimestampTradeData[]} concensusData - consensus data
 * @returns {TimestampTradeData}
 */
function aggrTradesData(assetsLength, concensusData) {
    const totalTradesData = Array(assetsLength).fill(0n).map(() => new Map())
    for (const timestampData of concensusData) {
        for (let i = 0; i < assetsLength; i++) {
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
                    sourceTotalTradesData = {volume: 0n, quoteVolume: 0n}
                    totalAssetTradesData.set(sourceTradeData.source, sourceTotalTradesData)
                }
                sourceTotalTradesData.volume += sourceTradeData.volume
                sourceTotalTradesData.quoteVolume += sourceTradeData.quoteVolume
            }
        }
    }
    const tradesData = totalTradesData.map(v => [...v.values()])
    return tradesData
}

async function getPriceForAsset(source, baseAsset, asset, timestamp) {
    const {settingsManager} = container
    const tradesData = aggrTradesData(1, await getConcensusData(source, baseAsset, [asset], timestamp, minute))
    const decimals = settingsManager.getDecimals()
    if (!tradesData || tradesData.length === 0 || tradesData[0] === null) {
        logger.warn({msg: 'Volume for asset not found', asset: asset.toString(), timestamp, source, baseAsset: baseAsset.toString()})
        return {price: 0n, decimals}
    }
    const price = calcPrice(tradesData, decimals)[0]
    if (price === 0n)
        logger.debug({msg: 'Price for asset not found', asset: asset.toString(), timestamp, source, baseAsset: baseAsset.toString()})
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
        logger.debug({msg: 'Price for pair not found', baseAsset: baseAsset.toString(), quoteAsset: quoteAsset.toString(), timestamp})
    return {price, decimals}
}

/**
 * One bit per node, in the order the caller passes them - getConcensusData passes the cluster node set sorted by
 * pubkey, so the bit a node gets is a pure function of the node set. Bitwise operators coerce to signed 32-bit
 * integers, so index 32 would alias onto index 0 in a cluster that large; BigInt keeps every node distinct.
 * @param {Iterable<{pubkey: string}>} nodes - cluster nodes, already ordered by the caller
 * @returns {{pubkey: string, mask: BigInt}[]}
 */
function buildNodeMasks(nodes) {
    return [...nodes].map(({pubkey}, index) => ({pubkey, mask: 1n << BigInt(index)}))
}

/**
 * Consensus trades data for the minutes of one timeframe. This node's own rows are its source of truth: a sample of its
 * own is kept when a majority of the node set reported the same volumes for the same asset and trade source. The
 * agreement set of every kept non-zero sample is tallied over the window, and only samples whose agreement set covers
 * the most frequent one are returned, so every node of that group returns the same data for the whole window.
 * @param {string} source - source of the data
 * @param {Asset} base - base asset
 * @param {Asset[]} assets - assets to get data for
 * @param {number} timestamp - timestamp to get data for
 * @param {number} timeframe - timeframe to get data for
 * @returns {Promise<TimestampTradeData[]>}
 */
async function getConcensusData(source, base, assets, timestamp, timeframe) {
    const {settingsManager, tradesManager} = container

    const majorityCount = getMajority(settingsManager.nodes.size)
    const currentPubkey = settingsManager.appConfig.publicKey

    //every node enumerates the same nodes in the same order: sorted by pubkey, never by Map insertion order
    const nodes = buildNodeMasks(
        [...settingsManager.nodes.values()]
            .map(({pubkey}) => ({pubkey}))
            .sort((a, b) => compareStrings(a.pubkey, b.pubkey))
    )

    logger.trace({msg: 'Getting concensus data', source, base: base.toString(), assets: assets.filter(a => a).map(a => a.toString()), expired: assets.filter(a => !a).length, timestamp, timeframe, nodes: nodes.map(n => n.pubkey)})

    const currentNodeMask = nodes.find(n => n.pubkey === currentPubkey)?.mask ?? 0n

    const isSameData = (a, b) =>
        a.volume === b.volume &&
        a.quoteVolume === b.quoteVolume

    let currentTimestamp = timestamp - timeframe
    /**@type {Map<BigInt, {occurrences: number, nodes: Set<string>}>} */
    const masks = new Map()
    //log only: members that did not hold a sample this node kept, told apart by whether they reported that trade source
    const missing = new Set()
    const mismatched = new Set()
    const candidate = []

    //get trades data for the current timestamp
    while (currentTimestamp < timestamp) {
        currentTimestamp += minute

        const tradesData = await tradesManager.getTradesData(
            source,
            base,
            assets,
            currentTimestamp
        )

        //count the cluster members that actually hold a row for this minute - Trades.getTradesData returns an entry
        //for every node that ever pushed anything, and its value is null when that node has nothing for this minute
        let presentCount = 0
        for (const {pubkey} of nodes)
            if (tradesData.get(pubkey))
                presentCount++

        //skip if majority is not possible
        if (presentCount < majorityCount) {
            logger.debug({msg: 'No majority for trades data', timestamp: currentTimestamp, source, base: base.code, present: presentCount, required: majorityCount})
            continue
        }

        //skip if no data for the current node
        const currentNodeData = tradesData.get(currentPubkey)
        if (!currentNodeData) {
            logger.debug({msg: 'Current node data missing', timestamp: currentTimestamp, source})
            continue
        }

        //check every sample of the current node against the other nodes; the cached rows are never modified
        const timestampData = currentNodeData.map(() => [])
        for (let assetIndex = 0; assetIndex < currentNodeData.length; assetIndex++) {
            const assetData = currentNodeData[assetIndex] || []
            //last source first, as main walks them: the order agreement sets are first seen in breaks ties below
            for (let sourceIndex = assetData.length - 1; sourceIndex >= 0; sourceIndex--) {
                const sourceData = assetData[sourceIndex]
                let sampleMask = currentNodeMask
                const sampleNodes = new Set([currentPubkey])
                for (const {pubkey, mask} of nodes) {
                    if (pubkey === currentPubkey)
                        continue

                    const nodeData = tradesData.get(pubkey)?.[assetIndex]?.find(d => d.source === sourceData.source)

                    //skip if no data for the node or if the data doesn't match
                    if (!nodeData || !isSameData(nodeData, sourceData)) {
                        (nodeData ? mismatched : missing).add(pubkey)
                        logger.debug({
                            msg: 'Node data mismatch',
                            timestamp: currentTimestamp,
                            source,
                            base: base.code,
                            asset: assetIndex,
                            node: pubkey,
                            sourceData: normalizePriceData(sourceData),
                            nodeData: normalizePriceData(nodeData)
                        })
                        continue
                    }

                    //add the node mask to the sample's agreement set
                    sampleMask |= mask
                    sampleNodes.add(pubkey)
                }

                //skip the sample if the majority is not reached
                if (sampleNodes.size < majorityCount)
                    continue

                timestampData[assetIndex].unshift({sample: sourceData, mask: sampleMask})

                //increment the mask count for the sample's agreement set (skip zero prices - they trivially agree
                //across all nodes)
                if (sourceData.volume > 0n) {
                    let maskStats = masks.get(sampleMask)
                    if (!maskStats) {
                        maskStats = {occurrences: 0, nodes: sampleNodes}
                        masks.set(sampleMask, maskStats)
                    }
                    maskStats.occurrences++
                }
            }
        }
        //push the current node data to the candidate list
        candidate.push(timestampData)
    }

    //log only
    dissentLog.report({
        source,
        base: base.code,
        missing: [...missing].sort(compareStrings),
        mismatched: [...mismatched].sort(compareStrings),
        self: currentPubkey
    })
    if (masks.size === 0) {
        logger.debug({msg: 'No matching nodes found', source, base: base.code})
        return []
    }
    //the most frequent agreement set; among equally frequent ones the first seen wins
    let bestMask = null
    for (const [mask, {occurrences}] of masks)
        if (bestMask === null || occurrences > masks.get(bestMask).occurrences)
            bestMask = mask

    //keep only the samples whose agreement set covers the best mask
    const result = candidate.map(timestampData => timestampData.map(assetData => assetData
        .filter(({mask}) => (mask & bestMask) === bestMask)
        .map(({sample}) => sample)))
    logger.debug({msg: 'Best matching mask found', source, base: base.code, bestMask: bestMask.toString(16), occurrences: masks.get(bestMask).occurrences, nodes: [...masks.get(bestMask).nodes].join(', ')})
    return result
}

/**
 * @param {{volume: BigInt, quoteVolume: BigInt}} [data] - one trades sample
 * @returns {{volume: string, quoteVolume: string}|null}
 */
function normalizePriceData(data) {
    if (!data)
        return null
    return {
        volume: (data.volume ? data.volume.toString() : undefined),
        quoteVolume: (data.quoteVolume ? data.quoteVolume.toString() : undefined)
    }
}


module.exports = {
    getPricesForContract,
    getPricesForPair,
    getConcensusData,
    buildNodeMasks
}