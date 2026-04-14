/*eslint-disable no-undef */
const {Asset, ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {getPricesForContract, getPricesForPair, getConcensusData} = require('../../../src/domain/prices/price-manager')

const decimals = 14
const minute = 60 * 1000

const nodes = [
    {pubkey: 'node1'},
    {pubkey: 'node2'},
    {pubkey: 'node3'}
]

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

function setupContainer(pubkey) {
    const nodesMap = new Map(nodes.map(n => [n.pubkey, {pubkey: n.pubkey}]))
    container.settingsManager = {
        appConfig: {publicKey: pubkey, dbSyncDelay: 0},
        config: {
            nodes: new Set(nodes),
            decimals,
            contracts: new Map()
        },
        nodes: nodesMap,
        getDecimals: () => decimals,
        getBaseAsset: (source) => {
            if (source === 'exchanges' || source === 'forex')
                return new Asset(2, 'USD')
            if (source === 'pubnet' || source === 'testnet')
                return new Asset(1, 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
            throw new Error(`Unknown source: ${source}`)
        },
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015'}),
        getContractConfig: (contractId) => container.settingsManager.config.contracts.get(contractId),
        getAssets: (contractId) => {
            const contract = container.settingsManager.config.contracts.get(contractId)
            return [...contract.assets]
        },
        getPriceHeartbeat: () => 2 * 60 * 60 * 1000
    }
}

/**
 * Feed identical trades data from all nodes into a trades manager
 */
function feedTradesData(key, assetsMap, timestamps, tradesFn) {
    jest.useFakeTimers()
    const tm = new TradesManager()
    container.tradesManager = tm

    const plainMap = assetsMap.toPlainObject()
    for (const node of nodes) {
        const nodeData = {}
        nodeData[key] = {}
        for (const ts of timestamps) {
            const trades = []
            for (let i = 0; i < assetsMap.assets.length; i++) {
                trades.push(tradesFn(i, ts))
            }
            nodeData[key][ts] = {
                assetsMap: plainMap,
                trades: normalizeTradeData(trades, true)
            }
        }
        tm.addSyncData(node.pubkey, nodeData)
    }
    return tm
}

/**
 * Feed per-node trades data (different data per node)
 */
function feedPerNodeTradesData(key, assetsMap, timestamps, tradesFnPerNode) {
    jest.useFakeTimers()
    const tm = new TradesManager()
    container.tradesManager = tm

    const plainMap = assetsMap.toPlainObject()
    for (const [nodeIdx, node] of nodes.entries()) {
        const nodeData = {}
        nodeData[key] = {}
        for (const ts of timestamps) {
            const trades = []
            for (let i = 0; i < assetsMap.assets.length; i++) {
                trades.push(tradesFnPerNode(nodeIdx, i, ts))
            }
            nodeData[key][ts] = {
                assetsMap: plainMap,
                trades: normalizeTradeData(trades, true)
            }
        }
        tm.addSyncData(node.pubkey, nodeData)
    }
    return tm
}

describe('getPricesForContract', () => {
    beforeEach(() => {
        setupContainer('node1')
    })

    test('computes prices for oracle contract with price-type trades', async () => {
        const assets = [new Asset(2, 'BTC'), new Asset(2, 'ETH')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 5 * minute
        const timestamps = [4 * minute, 5 * minute]

        container.settingsManager.config.contracts.set('contract1', {
            type: ContractTypes.ORACLE,
            contractId: 'contract1',
            dataSource: 'exchanges',
            baseAsset,
            assets,
            decimals,
            timeframe: 2 * minute
        })

        feedTradesData(key, assetsMap, timestamps, (assetIndex) => {
            //BTC = 50000, ETH = 3000 (scaled to 14 decimals)
            const prices = [50000n * (10n ** 14n), 3000n * (10n ** 14n)]
            return [{price: prices[assetIndex], source: 'binance', type: 'price'}]
        })

        const prices = await getPricesForContract('contract1', timestamp)

        expect(prices).toHaveLength(2)
        expect(prices[0]).toBeGreaterThan(0n)
        expect(prices[1]).toBeGreaterThan(0n)
        //BTC price should be higher than ETH
        expect(prices[0]).toBeGreaterThan(prices[1])
    })

    test('computes prices for oracle contract with volume-type trades', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 5 * minute
        const timestamps = [4 * minute, 5 * minute]

        container.settingsManager.config.contracts.set('contract1', {
            type: ContractTypes.ORACLE,
            contractId: 'contract1',
            dataSource: 'exchanges',
            baseAsset,
            assets,
            decimals,
            timeframe: 2 * minute
        })

        //volume=100, quoteVolume=2 => VWAP = 100*10^14 / 2 = 50*10^14
        feedTradesData(key, assetsMap, timestamps, () => [{volume: 100n, quoteVolume: 2n, source: 'binance', type: 'volume'}])

        const prices = await getPricesForContract('contract1', timestamp)

        expect(prices).toHaveLength(1)
        expect(prices[0]).toBeGreaterThan(0n)
    })

    test('throws when no trades data available', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')

        container.settingsManager.config.contracts.set('contract1', {
            type: ContractTypes.ORACLE,
            contractId: 'contract1',
            dataSource: 'exchanges',
            baseAsset,
            assets,
            decimals,
            timeframe: 2 * minute
        })

        //mock getTradesData to return empty map (bypasses TimestampSyncItem timeout)
        jest.useFakeTimers()
        const tm = new TradesManager()
        tm.getTradesData = jest.fn().mockResolvedValue(new Map())
        container.tradesManager = tm

        await expect(getPricesForContract('contract1', 5 * minute))
            .rejects.toThrow('Trades data not found')
    })

    test('skips zero prices during aggregation and still computes from non-zero timestamps', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 5 * minute
        const timestamps = [4 * minute, 5 * minute]

        container.settingsManager.config.contracts.set('contract1', {
            type: ContractTypes.ORACLE,
            contractId: 'contract1',
            dataSource: 'exchanges',
            baseAsset,
            assets,
            decimals,
            timeframe: 2 * minute
        })

        //timestamp 4min has zero price, timestamp 5min has real price
        feedTradesData(key, assetsMap, timestamps, (assetIndex, ts) => {
            if (ts === 4 * minute)
                return [{price: 0n, source: 'binance', type: 'price'}]
            return [{price: 50000n * (10n ** 14n), source: 'binance', type: 'price'}]
        })

        const prices = await getPricesForContract('contract1', timestamp)
        expect(prices).toHaveLength(1)
        //should still produce a price from the non-zero timestamp
        expect(prices[0]).toBeGreaterThan(0n)
    })

    test('handles multiple sources per asset', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 5 * minute
        const timestamps = [4 * minute, 5 * minute]

        container.settingsManager.config.contracts.set('contract1', {
            type: ContractTypes.ORACLE,
            contractId: 'contract1',
            dataSource: 'exchanges',
            baseAsset,
            assets,
            decimals,
            timeframe: 2 * minute
        })

        feedTradesData(key, assetsMap, timestamps, () => [
            {price: 50000n * (10n ** 14n), source: 'binance', type: 'price'},
            {price: 50100n * (10n ** 14n), source: 'kraken', type: 'price'}
        ])

        const prices = await getPricesForContract('contract1', timestamp)
        expect(prices).toHaveLength(1)
        expect(prices[0]).toBeGreaterThan(0n)
    })

    test('handles oracle_beam contract type', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 5 * minute
        const timestamps = [4 * minute, 5 * minute]

        container.settingsManager.config.contracts.set('beam1', {
            type: ContractTypes.ORACLE_BEAM,
            contractId: 'beam1',
            dataSource: 'exchanges',
            baseAsset,
            assets,
            decimals,
            timeframe: 2 * minute
        })

        feedTradesData(key, assetsMap, timestamps, () => [{price: 50000n * (10n ** 14n), source: 'binance', type: 'price'}])

        const prices = await getPricesForContract('beam1', timestamp)
        expect(prices).toHaveLength(1)
        expect(prices[0]).toBeGreaterThan(0n)
    })
})

describe('getConcensusData', () => {
    beforeEach(() => {
        setupContainer('node1')
    })

    test('returns empty when no data available', async () => {
        jest.useFakeTimers()
        const tm = new TradesManager()
        tm.getTradesData = jest.fn().mockResolvedValue(new Map())
        container.tradesManager = tm

        const result = await getConcensusData('exchanges', new Asset(2, 'USD'), [new Asset(2, 'BTC')], 5 * minute, 2 * minute)
        expect(result).toEqual([])
    })

    test('excludes source data that does not reach majority', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 5 * minute
        const timestamps = [4 * minute, 5 * minute]

        //node1 and node3 report price 100, node2 reports price 200
        //majority (2 out of 3) agrees on 100
        feedPerNodeTradesData(key, assetsMap, timestamps, (nodeIdx) => {
            const price = nodeIdx === 1 ? 200n * (10n ** 14n) : 100n * (10n ** 14n)
            return [{price, source: 'binance', type: 'price'}]
        })

        const result = await getConcensusData('exchanges', baseAsset, assets, timestamp, 2 * minute)

        expect(result.length).toBeGreaterThan(0)
        //all returned data should have price 100 (the majority value)
        for (const timestampData of result) {
            for (const assetData of timestampData) {
                for (const trade of assetData) {
                    expect(trade.price).toBe(100n * (10n ** 14n))
                }
            }
        }
    })

    test('zero-price sources do not count toward mask selection', async () => {
        const assets = [new Asset(2, 'BTC'), new Asset(2, 'ETH')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 3 * minute
        const timestamps = [2 * minute, 3 * minute]

        //all nodes agree: BTC has a real price, ETH has zero price
        feedTradesData(key, assetsMap, timestamps, (assetIndex) => {
            if (assetIndex === 0)
                return [{price: 50000n * (10n ** 14n), source: 'binance', type: 'price'}]
            return [{price: 0n, source: 'binance', type: 'price'}]
        })

        const result = await getConcensusData('exchanges', baseAsset, assets, timestamp, 2 * minute)

        //should still get consensus based on non-zero BTC data
        expect(result.length).toBeGreaterThan(0)
    })

    test('returns data when all nodes agree', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')
        const assetsMap = new AssetsMap('exchanges', baseAsset, assets)
        const key = 'exchanges_USD'

        const timestamp = 3 * minute
        const timestamps = [2 * minute, 3 * minute]

        feedTradesData(key, assetsMap, timestamps, () => [{price: 42000n * (10n ** 14n), source: 'binance', type: 'price'}])

        const result = await getConcensusData('exchanges', baseAsset, assets, timestamp, 2 * minute)

        expect(result.length).toBe(2) //2 timestamps within timeframe
        for (const timestampData of result) {
            expect(timestampData[0][0].price).toBe(42000n * (10n ** 14n))
        }
    })

    test('skips timestamp when less than majority nodes report', async () => {
        const assets = [new Asset(2, 'BTC')]
        const baseAsset = new Asset(2, 'USD')

        jest.useFakeTimers()
        const tm = new TradesManager()
        container.tradesManager = tm

        //mock getTradesData to return only 1 node — below majority of 2
        tm.getTradesData = jest.fn().mockResolvedValue(new Map([
            ['node1', [[{price: 100n * (10n ** 14n), source: 'binance', type: 'price'}]]]
        ]))

        const result = await getConcensusData('exchanges', baseAsset, assets, 3 * minute, minute)
        expect(result).toEqual([])
    })
})

describe('getPricesForPair', () => {
    beforeEach(() => {
        setupContainer('node1')
    })

    test('returns zero price when no data for either side', async () => {
        jest.useFakeTimers()
        const tm = new TradesManager()
        tm.getTradesData = jest.fn().mockResolvedValue(new Map())
        container.tradesManager = tm

        const result = await getPricesForPair(
            'exchanges', new Asset(2, 'ETH'),
            'exchanges', new Asset(2, 'BTC'),
            3 * minute
        )

        expect(result.price).toBe(0n)
        expect(result.decimals).toBe(decimals)
    })

    test('returns precise value when quote asset is the source base asset', async () => {
        const baseAsset = new Asset(2, 'USD')
        const pairBase = new Asset(2, 'ETH')
        const ethMap = new AssetsMap('exchanges', baseAsset, [pairBase])
        const key = 'exchanges_USD'

        const timestamp = 3 * minute
        const timestamps = [2 * minute, 3 * minute]

        feedTradesData(key, ethMap, timestamps, () => [{price: 3000n * (10n ** 14n), source: 'binance', type: 'price'}, {price: 3050n * (10n ** 14n), source: 'okx', type: 'price'}])

        //quote is USD which is the base asset for 'exchanges' — should use precise value 1
        const result = await getPricesForPair(
            'exchanges', pairBase,
            'exchanges', baseAsset,
            timestamp
        )

        expect(result.price).toBeGreaterThan(0n)
        expect(result.decimals).toBe(decimals)
    })

    test('returns precise value when base asset is the source base asset', async () => {
        const baseAsset = new Asset(2, 'USD')
        const quoteAsset = new Asset(2, 'BTC')
        const btcMap = new AssetsMap('exchanges', baseAsset, [quoteAsset])
        const key = 'exchanges_USD'

        const timestamp = 3 * minute
        const timestamps = [2 * minute, 3 * minute]

        feedTradesData(key, btcMap, timestamps, () => [{price: 50000n * (10n ** 14n), source: 'binance', type: 'price'}])

        //base is USD which is the base asset for 'exchanges' — should use precise value 1
        const result = await getPricesForPair(
            'exchanges', baseAsset,
            'exchanges', quoteAsset,
            timestamp
        )

        expect(result.price).toBeGreaterThan(0n)
        expect(result.decimals).toBe(decimals)
    })
})
