/*eslint-disable no-undef */
const {Asset, getMajority} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const {getConcensusData} = require('../../../src/domain/prices/price-manager')
const {calcPrice} = require('../../../src/utils/price-utils') //for full price computation
const TradesManager = require('../../../src/domain/prices/trades-manager')
const logger = require('../../../src/logger')

const nodes = [
    {pubkey: 'node1'},
    {pubkey: 'node2'},
    {pubkey: 'node3'},
    {pubkey: 'node4'},
    {pubkey: 'node5'},
    {pubkey: 'node6'},
    {pubkey: 'node7'}
]

const minute = 60 * 1000

function normalizeTradeData(data, toString) {
    function normalizeValue(value) {
        return toString ? value.toString() : BigInt(value)
    }
    return data.map(assetTradeData =>
        assetTradeData.map(({ts, ...tradeData}) => {
            if (tradeData.type === 'price') {
                tradeData.price = normalizeValue(tradeData.price, toString)
            } else {
                tradeData.volume = normalizeValue(tradeData.volume, toString)
                tradeData.quoteVolume = normalizeValue(tradeData.quoteVolume, toString)
            }
            return tradeData
        })
    )
}

function buildPriceData(prices, source) {
    return prices.map(price => {
        const entry = {price, type: 'price'}
        if (source !== undefined) entry.source = source
        return [entry]
    })
}

function setupContainer(currentNodeIndex) {
    container.settingsManager = {
        appConfig: {publicKey: nodes[currentNodeIndex].pubkey},
        config: {
            nodes: new Set(nodes)
        },
        nodes: new Map(nodes.map(node => [node.pubkey, {pubkey: node.pubkey}]))
    }
}

function createTradesManager() {
    const tm = new TradesManager()
    container.tradesManager = tm
    return tm
}

/**
 * Feed price data from all nodes into the trades manager.
 * @param {TradesManager} tm
 * @param {AssetsMap} assetsMap
 * @param {number[]} timestamps - minute-level timestamps
 * @param {function(nodeIndex, timestamp): Array} priceDataFn - returns price data per node+timestamp
 */
function feedAllNodes(tm, assetsMap, timestamps, priceDataFn) {
    const key = `${assetsMap.source}_${assetsMap.baseAsset.code}`
    const plainMap = assetsMap.toPlainObject()
    for (let n = 0; n < nodes.length; n++) {
        const nodeData = {}
        nodeData[key] = {}
        for (const ts of timestamps) {
            nodeData[key][ts] = {
                assetsMap: plainMap,
                trades: normalizeTradeData(priceDataFn(n, ts), true)
            }
        }
        tm.addSyncData(nodes[n].pubkey, nodeData)
    }
}

/**
 * Run the full aggregation pipeline (like getPricesForContract does after getConcensusData)
 */
function aggregatePrices(concensusData, assetCount) {
    const totalTradesData = Array(assetCount).fill(0n).map(() => new Map())
    for (const timestampData of concensusData) {
        for (let i = 0; i < assetCount; i++) {
            if (timestampData.length <= i) break
            const totalAssetTradesData = totalTradesData[i]
            const assetTradeData = timestampData[i]
            for (const sourceTradeData of assetTradeData) {
                let sourceTotalTradesData = totalAssetTradesData.get(sourceTradeData.source)
                if (!sourceTotalTradesData) {
                    sourceTotalTradesData = sourceTradeData.type === 'price'
                        ? {sum: 0n, entries: 0, type: 'price'}
                        : {volume: 0n, quoteVolume: 0n}
                    totalAssetTradesData.set(sourceTradeData.source, sourceTotalTradesData)
                }
                if (sourceTotalTradesData.type === 'price') {
                    if (sourceTradeData.price === 0n)
                        continue
                    sourceTotalTradesData.sum += sourceTradeData.price
                    sourceTotalTradesData.entries++
                } else {
                    sourceTotalTradesData.volume += sourceTradeData.volume
                    sourceTotalTradesData.quoteVolume += sourceTradeData.quoteVolume
                }
            }
        }
    }
    return totalTradesData.map(v => [...v.values()])
}

describe('getConcensusData — consensus', () => {
    const timeframe = 5 * minute
    const oracleTimestamp = 15 * minute
    const minuteTimestamps = [11, 12, 13, 14, 15].map(t => t * minute)

    beforeAll(() => {
        logger.setTrace(true)
    })

    test('49 assets, 34 zero, 15 non-zero, one disagreeing node', async () => {
        const allAssets = []
        for (let i = 0; i < 49; i++) {
            allAssets.push(new Asset(2, `A${i}`))
        }
        const prodAssetsMap = new AssetsMap('pubnet', new Asset(2, 'USDC'), allAssets)

        setupContainer(0)
        const tm = createTradesManager()

        feedAllNodes(tm, prodAssetsMap, minuteTimestamps, (nodeIndex) => {
            const prices = []
            for (let i = 0; i < 49; i++) {
                if (i < 15) {
                    //assets 0-14: have prices on 6 nodes, zero on node7
                    prices.push(nodeIndex === 6 ? 0n : BigInt(1000000 + i * 100))
                } else {
                    //assets 15-48: has zero on all nodes (no trading activity)
                    prices.push(0n)
                }
            }
            return buildPriceData(prices)
        })

        for (let i = 0; i < nodes.length; i++) {
            setupContainer(i)
            container.tradesManager = tm

            const result = await getConcensusData(
                prodAssetsMap.source,
                prodAssetsMap.baseAsset,
                allAssets,
                oracleTimestamp,
                timeframe
            )
            //5 timestamp entries
            expect(result.length).toBe(i === 6 ? 0 : 5)

            const aggregated = aggregatePrices(result, 49)
            let assetsWithData = 0
            for (let i = 0; i < 15; i++) {
                const assetAgg = aggregated[i]
                if (assetAgg.length > 0 && assetAgg[0].entries > 0) {
                    assetsWithData++
                }
            }

            expect(assetsWithData).toBe(i === 6 ? 0 : 15)
        }
    })

    test('disagreeing node has zero on ALL assets', async () => {
        const allAssets = []
        for (let i = 0; i < 10; i++) {
            allAssets.push(new Asset(2, `A${i}`))
        }
        const assetsMap10 = new AssetsMap('test', new Asset(2, 'BASE'), allAssets)

        setupContainer(0)
        const tm = createTradesManager()

        feedAllNodes(tm, assetsMap10, minuteTimestamps, (nodeIndex) =>
            //ALL 10 assets have non-zero prices on 6 nodes, zero on node7
            buildPriceData(
                Array(10).fill(null).map((_, i) => nodeIndex === 6 ? 0n : BigInt(100 + i))
            )
        )

        const result = await getConcensusData(
            assetsMap10.source,
            assetsMap10.baseAsset,
            allAssets,
            oracleTimestamp,
            timeframe
        )

        expect(result.length).toBe(5)
        for (const ts of result) {
            for (const assetData of ts) {
                expect(assetData.length).toBe(1)
                expect(assetData[0].price).toBeGreaterThan(0n)
            }
        }
    })

    test('nodes with different data for 3 assets', async () => {
        const allAssets = [new Asset(2, 'USD'), new Asset(2, 'EUR'), new Asset(2, 'GBP')]
        const prodAssetsMap = new AssetsMap('pubnet', new Asset(2, 'USDC'), allAssets)

        setupContainer(0)
        const tm = createTradesManager()

        feedAllNodes(tm, prodAssetsMap, minuteTimestamps, (nodeIndex) => {
            const prices = [1n]
            prices.push(nodeIndex === 1 ? 0n : 1n)
            prices.push(nodeIndex === 2 ? 0n : 1n)
            return buildPriceData(prices)
        })

        const expected = new Array(minuteTimestamps.length).fill(null).map(() => [1n, undefined, undefined])

        for (let i = 0; i < nodes.length; i++) {
            setupContainer(i)
            container.tradesManager = tm
            const result = await getConcensusData(
                prodAssetsMap.source,
                prodAssetsMap.baseAsset,
                allAssets,
                oracleTimestamp,
                timeframe
            )

            expect(result.map((ts) => ts.flatMap((entry) => entry[0]?.price))).toEqual(expected)
        }
    })
})
