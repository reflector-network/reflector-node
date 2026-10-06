/*eslint-disable no-undef */
const {Asset, ContractTypes, getMajority} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const {getConcensusData} = require('../../../src/domain/prices/price-manager')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')
const logger = require('../../../src/logger')

stopTradesManagersAfterEach(TradesManager)

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
        assetTradeData.map(({ts, ...tradeData}) => {//we need ts only for debugging purposes, so we can remove it from the data that we send to sync
            tradeData.volume = normalizeValue(tradeData.volume, toString)
            tradeData.quoteVolume = normalizeValue(tradeData.quoteVolume, toString)
            return tradeData
        })
    )
}

function buildTradesData(prices, source) {
    return prices.map(price => {
        const entry = {volume: price, quoteVolume: 10n ** 14n}
        if (source !== undefined) entry.source = source
        return [entry]
    })
}

function setupContainer(currentNodeIndex) {
    container.settingsManager = {
        appConfig: {publicKey: nodes[currentNodeIndex].pubkey},
        //one oracle on each fixture key makes them keys this node reads, so peers register on arrival
        config: {
            nodes: new Set(nodes),
            contracts: new Map([
                ['oracle-pubnet', {contractId: 'oracle-pubnet', type: ContractTypes.ORACLE, dataSource: 'pubnet', baseAsset: new Asset(2, 'USDC')}],
                ['oracle-test', {contractId: 'oracle-test', type: ContractTypes.ORACLE, dataSource: 'test', baseAsset: new Asset(2, 'BASE')}],
                ['oracle-exchanges', {contractId: 'oracle-exchanges', type: ContractTypes.ORACLE, dataSource: 'exchanges', baseAsset: new Asset(2, 'USD')}]
            ])
        },
        nodes: new Map(nodes.map(node => [node.pubkey, {pubkey: node.pubkey}])),
        getAssets: () => [],
        getPriceHeartbeat: () => 2 * 60 * 60 * 1000
    }
}

//the fixture lists its key as a contract, so addSyncData builds the key list the way production does and the
//list's error branch never runs here
beforeEach(() => {
    logger.error.mockClear()
})

afterEach(() => {
    expect(logger.error.mock.calls.filter(call => call[0]?.msg === 'Failed to build the local cache keys')).toHaveLength(0)
})


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
 * @param {boolean} [overWire] - pass each node's data through JSON, as the ws layer sends and parses it
 */
function feedAllNodes(tm, assetsMap, timestamps, priceDataFn, overWire = false) {
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
        tm.addSyncData(nodes[n].pubkey, overWire ? JSON.parse(JSON.stringify(nodeData)) : nodeData)
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
                    sourceTotalTradesData = {volume: 0n, quoteVolume: 0n}
                    totalAssetTradesData.set(sourceTradeData.source, sourceTotalTradesData)
                }
                sourceTotalTradesData.volume += sourceTradeData.volume
                sourceTotalTradesData.quoteVolume += sourceTradeData.quoteVolume
            }
        }
    }
    return totalTradesData.map(v => [...v.values()])
}

let nowSpy

beforeEach(() => {
    //addSyncData bounds peer timestamps against the local clock. Pin it inside the newest fixture minute's sync
    //window (ts + priceSyncDelay 15 s + 25 s): that item's own timer is then still 30 s out, so if peer presentation
    //broke, the consensus tests would wait on it and fail instead of passing through a 1 ms timeout, as they do at 16 min.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(15 * minute + 10 * 1000)
})

afterEach(() => {
    nowSpy.mockRestore()
})

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
            return buildTradesData(prices)
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
            //5 timestamp entries; the node whose own feed reports zero for all 15 priced assets keeps none of them
            expect(result.length).toBe(i === 6 ? 0 : 5)

            const aggregated = aggregatePrices(result, 49)
            let assetsWithData = 0
            for (let i = 0; i < 15; i++) {
                const assetAgg = aggregated[i]
                if (assetAgg.length > 0 && assetAgg[0].volume > 0n) {
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
            buildTradesData(
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
                expect(assetData[0].volume).toBeGreaterThan(0n)
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
            return buildTradesData(prices)
        })

        //the most frequent majority group is the full node set, so the two assets one node disagrees on are dropped
        //on every node and all seven compute the same vector
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

            expect(result.map((ts) => ts.flatMap((entry) => entry[0]?.volume))).toEqual(expected)
        }
    })

    test('every node one asset short, as a shared exchange failure leaves them, still agrees on the rest', async () => {
        //every provider failed for A2, the map's last asset, on every node at the same minutes (the upstream is
        //shared), so every row is one entry short; the contract reads only the assets those rows carry
        const allAssets = [new Asset(2, 'A0'), new Asset(2, 'A1'), new Asset(2, 'A2')]
        const map = new AssetsMap('exchanges', new Asset(2, 'USD'), allAssets)
        setupContainer(0)
        const tm = createTradesManager()
        feedAllNodes(tm, map, minuteTimestamps, () => buildTradesData([1000n, 2000n], 'binance'))

        for (let i = 0; i < nodes.length; i++) {
            setupContainer(i)
            container.tradesManager = tm
            const result = await getConcensusData(map.source, map.baseAsset, allAssets.slice(0, 2), oracleTimestamp, timeframe)

            expect(result.map(ts => ts.map(entry => entry[0]?.volume))).toEqual(Array(5).fill([1000n, 2000n]))
        }
    })

    test('every node with the same hole mid-row, as a shared exchange failure leaves it, agrees on the rest', async () => {
        //every provider failed for A2, which sits between assets that have data, on every node at the same minutes (the
        //upstream is shared), so every row has a hole there, which JSON sends as null
        const allAssets = [new Asset(2, 'A0'), new Asset(2, 'A1'), new Asset(2, 'A2'), new Asset(2, 'A3')]
        const map = new AssetsMap('exchanges', new Asset(2, 'USD'), allAssets)
        setupContainer(0)
        const tm = createTradesManager()
        feedAllNodes(tm, map, minuteTimestamps, () => {
            const row = buildTradesData([1000n, 2000n, 0n, 4000n], 'binance')
            delete row[2]
            return row
        }, true)

        const read = [allAssets[0], allAssets[1], allAssets[3]]
        for (let i = 0; i < nodes.length; i++) {
            setupContainer(i)
            container.tradesManager = tm
            const result = await getConcensusData(map.source, map.baseAsset, read, oracleTimestamp, timeframe)

            expect(result.map(ts => ts.map(entry => entry[0]?.volume))).toEqual(Array(5).fill([1000n, 2000n, 4000n]))
        }
    })

    test('sync items resolve through peer presentation, not the timeout', () => {
        const assets = [new Asset(2, 'A0')]
        const map = new AssetsMap('pubnet', new Asset(2, 'USDC'), assets)
        setupContainer(0)
        const tm = createTradesManager()
        feedAllNodes(tm, map, minuteTimestamps, () => buildTradesData([1000n]))

        for (const ts of minuteTimestamps)
            expect(tm.__timestamps.get(ts).get('pubnet_USDC').isProcessed).toBe(true)
        expect(logger.warn.mock.calls.filter(c => c[0]?.msg === 'TimestampSyncItem auto-resolved by timeout')).toHaveLength(0)
    })
})
