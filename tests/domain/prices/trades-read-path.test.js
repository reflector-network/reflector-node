/*eslint-disable no-undef */
const {Asset, ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const dataSourcesManager = require('../../../src/domain/data-sources-manager')
const nodesManager = require('../../../src/domain/nodes/nodes-manager')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const Trades = require('../../../src/domain/prices/trades-cache')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')
const {getConcensusData} = require('../../../src/domain/prices/price-manager')
const logger = require('../../../src/logger')

stopTradesManagersAfterEach(TradesManager)

const key = 'exchanges_USD'
const timestamp = 5 * 60 * 1000
const self = 'self-node'
const peerA = 'peer-a'
const peerB = 'peer-b'
const assets = [new Asset(2, 'BTC'), new Asset(2, 'ETH')]

beforeEach(() => {
    const pubkeys = [self, peerA, peerB]
    container.settingsManager = {
        appConfig: {publicKey: self},
        nodes: new Map(pubkeys.map(p => [p, {pubkey: p}])),
        getPriceHeartbeat: () => 2 * 60 * 60 * 1000
    }
})

/**
 * @param {string[]} codes - asset codes the map carries
 * @returns {AssetsMap}
 */
function makeMap(codes) {
    return new AssetsMap('exchanges', new Asset(2, 'USD'), codes.map(c => new Asset(2, c)))
}

//the fixture lists its key as a contract, so addSyncData builds the key list the way production does and the
//list's error branch never runs here
beforeEach(() => {
    logger.error.mockClear()
})

afterEach(() => {
    expect(logger.error.mock.calls.filter(call => call[0]?.msg === 'Failed to build the local cache keys')).toHaveLength(0)
})

describe('trades read path', () => {
    test('an item whose assets field is not an array yields no data and does not throw', () => {
        const trades = new Trades()
        trades.push(peerA, key, new AssetsMap('exchanges', new Asset(2, 'USD'), 'x'), timestamp, [])

        const data = trades.getTradesData(key, timestamp, assets)

        expect(data.get(peerA)).toEqual([[], []])
    })

    test('an item with fewer trades rows than assets yields an empty row for the missing asset', () => {
        const trades = new Trades()
        //an item built before the validator existed, or by an older peer
        trades.push(peerA, key, makeMap(['BTC', 'ETH']), timestamp, [[{volume: '1', quoteVolume: '2', source: 'binance'}]])

        const data = trades.getTradesData(key, timestamp, assets)

        expect(data.get(peerA)).toEqual([[{volume: 1n, quoteVolume: 2n, source: 'binance'}], []])
    })

    test('a sparse provider row caches and reads as an empty row', () => {
        const trades = new Trades()
        const sparse = []
        sparse[1] = [{volume: '5', quoteVolume: '6', source: 'okx'}] //index 0 is a hole
        trades.push(self, key, makeMap(['BTC', 'ETH']), timestamp, sparse)

        const data = trades.getTradesData(key, timestamp, assets)

        expect(data.get(self)).toEqual([[], [{volume: 5n, quoteVolume: 6n, source: 'okx'}]])
    })

    test('one unreadable peer does not stop the others', () => {
        const trades = new Trades()
        trades.push(peerA, key, makeMap(['BTC', 'ETH']), timestamp, [
            [{volume: '1', quoteVolume: '2', source: 'binance'}],
            [{volume: '3', quoteVolume: '4', source: 'binance'}]
        ])
        //a cache item whose assetsMap throws on any read
        const poisoned = {
            getTradesData() {
                throw new Error('poison')
            }
        }
        trades.push(peerB, key, makeMap(['BTC', 'ETH']), timestamp, [[], []])
        trades.__trades.get(peerB).__trades.get(key).set(timestamp, poisoned)

        const data = trades.getTradesData(key, timestamp, assets)

        expect(data.get(peerA)).toHaveLength(2)
        expect(data.get(peerB)).toBeNull()
    })

    test('a null asset in the request yields an empty row rather than a lookup', () => {
        const trades = new Trades()
        trades.push(peerA, key, makeMap(['BTC', 'ETH']), timestamp, [
            [{volume: '1', quoteVolume: '2', source: 'binance'}],
            [{volume: '3', quoteVolume: '4', source: 'binance'}]
        ])

        const data = trades.getTradesData(key, timestamp, [null, assets[1]])

        expect(data.get(peerA)).toEqual([[], [{volume: 3n, quoteVolume: 4n, source: 'binance'}]])
    })

    test('a trades row shorter than the assets list is padded when the item is built', () => {
        const trades = new Trades()
        const item = trades.push(self, key, makeMap(['BTC', 'ETH', 'XLM']), timestamp, [[{volume: '1', quoteVolume: '2', source: 'binance'}]])

        expect(item.trades).toHaveLength(3)
        expect(item.toPlainObject().trades).toEqual([[{volume: '1', quoteVolume: '2', source: 'binance'}], [], []])
    })
})

describe('the node\'s own rows on the local path', () => {
    const minute = 60 * 1000
    const T0 = 1000 * minute
    const count = 15 //loadTradesDataForSource asks for the whole cache on an empty one
    const usd = new Asset(2, 'USD')
    const [btc, sol, eth, xrp] = ['BTC', 'SOL', 'ETH', 'XRP'].map(code => new Asset(2, code))
    const mapAssets = [btc, sol, eth, xrp]
    const btcTrade = {volume: 100n, quoteVolume: 200n, source: 'binance'}
    const ethTrade = {volume: 300n, quoteVolume: 400n, source: 'binance'}

    //canonical text of a read, BigInt spelled with its n suffix, so a string '5' never matches a BigInt 5n
    const text = value => JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? `${v}n` : v))

    let nowSpy
    let dataSource
    let originalInstance
    let originalBroadcast
    let broadcasts

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0 + 24 * 1000) //inside T0's sync window
        const pubkeys = [self, peerA, peerB]
        container.settingsManager = {
            appConfig: {publicKey: self},
            //one oracle on exchanges/USD makes it a key this node reads, so peers register on arrival
            config: {
                nodes: new Map(pubkeys.map(p => [p, {pubkey: p}])),
                contracts: new Map([['oracle', {contractId: 'oracle', type: ContractTypes.ORACLE, dataSource: 'exchanges', baseAsset: usd}]])
            },
            nodes: new Map(pubkeys.map(p => [p, {pubkey: p}])),
            getAssets: () => [],
            getPriceHeartbeat: () => 2 * 60 * 60 * 1000,
            getSimSource: () => undefined
        }
        dataSource = dataSourcesManager.get('exchanges')
        originalInstance = dataSource.instance
        originalBroadcast = nodesManager.broadcast
        broadcasts = []
        nodesManager.broadcast = message => broadcasts.push(JSON.parse(JSON.stringify(message)))
        logger.warn.mockClear()
    })

    afterEach(() => {
        nowSpy.mockRestore()
        dataSource.instance = originalInstance
        nodesManager.broadcast = originalBroadcast
    })

    /**
     * The row the exchanges connector returns for [BTC, SOL, ETH, XRP] when every provider failed for SOL and XRP: its
     * pivot creates an asset's slot only for data, so SOL is a hole and XRP is missing at the tail
     * @returns {Array} a sparse row of length 3
     */
    function connectorRow() {
        const row = []
        row[0] = [{...btcTrade, ts: 1}]
        row[2] = [{...ethTrade, ts: 1}]
        return row
    }

    /**
     * Loads this node's own data through loadTradesDataForSource from a provider that returns the given rows
     * @param {function(number): *} rows - provider result for the requested count
     * @returns {Promise<TradesManager>}
     */
    async function loadOwn(rows) {
        dataSource.instance = {getPriceData: ({count: requested}) => Promise.resolve(rows(requested))}
        const tm = new TradesManager()
        container.tradesManager = tm
        await tm.loadTradesDataForSource(new AssetsMap('exchanges', usd, [...mapAssets]))
        return tm
    }

    test('a contract that reads the asset its own row has no data for keeps its tick', async () => {
        const tm = await loadOwn(requested => Array.from({length: requested}, connectorRow))
        const gossip = broadcasts[0].data
        tm.addSyncData(peerA, gossip)
        tm.addSyncData(peerB, gossip)

        const result = await getConcensusData('exchanges', usd, [btc, sol, eth], T0, 5 * minute)

        expect(result).toHaveLength(5)
        for (const minuteData of result)
            expect(minuteData).toEqual([[btcTrade], [], [ethTrade]])
    })

    test('the node gossips its own row dense, in a shape it accepts from a peer', async () => {
        await loadOwn(requested => Array.from({length: requested}, connectorRow))

        const wire = broadcasts[0].data[key][T0].trades

        expect(wire).toEqual([
            [{volume: '100', quoteVolume: '200', source: 'binance'}],
            [],
            [{volume: '300', quoteVolume: '400', source: 'binance'}],
            []
        ])
    })

    test('a hole reads byte-identically on the local path and from a peer, whichever way the peer spelled it', async () => {
        const tm = await loadOwn(requested => Array.from({length: requested}, connectorRow))
        //peer A sends what this version sends; peer B what a sender before it sent: null for the hole, the tail cut off
        tm.addSyncData(peerA, broadcasts[0].data)
        const legacy = JSON.parse(`{"${key}":{"${T0}":{"assetsMap":{"source":"exchanges","baseAsset":{"type":2,"code":"USD"},`
            + '"assets":[{"type":2,"code":"BTC"},{"type":2,"code":"SOL"},{"type":2,"code":"ETH"},{"type":2,"code":"XRP"}]},'
            + '"trades":[[{"volume":"100","quoteVolume":"200","source":"binance"}],null,[{"volume":"300","quoteVolume":"400","source":"binance"}]]}}}')
        tm.addSyncData(peerB, legacy)

        const reads = tm.__trades.getTradesData(key, T0, [xrp, sol, eth, btc])

        expect(reads.get(self)).toEqual([[], [], [ethTrade], [btcTrade]])
        expect(text(reads.get(peerA))).toBe(text(reads.get(self)))
        expect(text(reads.get(peerB))).toBe(text(reads.get(self)))
    })

    test('a provider that returns fewer rows than asked is noticed', async () => {
        await loadOwn(requested => Array.from({length: requested - 1}, connectorRow))

        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Data source returned an unexpected number of rows',
            expected: count,
            received: count - 1
        }))
    })

    test('a provider that returns no rows at all fails the load with a message, not a TypeError', async () => {
        dataSource.instance = {getPriceData: () => Promise.resolve({length: count})}
        const tm = new TradesManager()
        container.tradesManager = tm

        await expect(tm.loadTradesDataForSource(new AssetsMap('exchanges', usd, [...mapAssets])))
            .rejects.toThrow('Data source exchanges returned no rows')
        expect(broadcasts).toHaveLength(0)
    })
})
