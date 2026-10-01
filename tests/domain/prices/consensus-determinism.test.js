/*eslint-disable no-undef */
const {Asset, ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')
const {getConcensusData} = require('../../../src/domain/prices/price-manager')
const logger = require('../../../src/logger')

stopTradesManagersAfterEach(TradesManager)

const minute = 60 * 1000
//inside the newest fixture minute's sync window (ts + dbSyncDelay + 25 s), as consensus-mask.test.js pins it: sync
//items then resolve through peer presentation, and a broken presentation stalls a test instead of passing it through
//a 1 ms timeout
const now = 15 * minute + 10 * 1000
const timeframe = 5 * minute
const oracleTimestamp = 15 * minute
const minuteTimestamps = [11, 12, 13, 14, 15].map(t => t * minute)
const source = 'exchanges'
const baseAsset = new Asset(2, 'USD')
const key = `${source}_${baseAsset.code}`
const quoteVolume = '100000000000000'

const btc = new Asset(2, 'BTC')
const eth = new Asset(2, 'ETH')

let nowSpy

beforeEach(() => {
    jest.clearAllMocks()
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
})

afterEach(() => {
    nowSpy.mockRestore()
})

//the fixture lists its key as a contract, so addSyncData builds the key list the way production does and the
//list's error branch never runs here
beforeEach(() => {
    logger.error.mockClear()
})

afterEach(() => {
    expect(logger.error.mock.calls.filter(call => call[0]?.msg === 'Failed to build the local cache keys')).toHaveLength(0)
})

/**
 * @param {number} count - cluster size
 * @returns {string[]} node pubkeys
 */
function makeNodes(count) {
    return Array.from({length: count}, (_, i) => `node-${String(i).padStart(2, '0')}`)
}

/**
 * @param {string[]} pubkeys - cluster node pubkeys, in the order this node's settings hold them
 * @param {string} self - the node running the computation
 */
function setupContainer(pubkeys, self) {
    container.settingsManager = {
        appConfig: {publicKey: self, dbSyncDelay: 0},
        //one oracle on the fixture key makes it a key this node reads, so peers register on arrival
        config: {
            nodes: new Map(pubkeys.map(p => [p, {pubkey: p}])),
            contracts: new Map([['oracle', {contractId: 'oracle', type: ContractTypes.ORACLE, dataSource: source, baseAsset}]])
        },
        nodes: new Map(pubkeys.map(p => [p, {pubkey: p}])),
        getAssets: () => [],
        getPriceHeartbeat: () => 2 * 60 * 60 * 1000
    }
}

/**
 * @param {string} tradeSource - exchange name
 * @param {string} volume - decimal volume
 * @returns {object[]} one sample for one asset at one minute
 */
function row(tradeSource, volume) {
    return [{volume, quoteVolume, source: tradeSource}]
}

/**
 * One shared cache for the whole cluster: every node holds the same gossip, which is the condition under which the
 * selection has to converge. `rowsFn` returns the rows one node holds for one asset at one minute, `[]` when that
 * node has no sample for that asset, and `null` when it holds no row for that key and minute at all. The feed runs as
 * node-00, which holds data in every fixture that has any, so the sync items resolve through presentation.
 * @param {string[]} pubkeys - cluster node pubkeys
 * @param {Asset[]} assets - assets of the map
 * @param {function(string, number, number): object[]} rowsFn - (pubkey, assetIndex, timestamp) -> rows
 * @returns {TradesManager}
 */
function feedCluster(pubkeys, assets, rowsFn) {
    setupContainer(pubkeys, pubkeys[0])
    const tradesManager = new TradesManager()
    container.tradesManager = tradesManager
    const plainMap = new AssetsMap(source, baseAsset, assets).toPlainObject()
    for (const pubkey of pubkeys) {
        const nodeData = {[key]: {}}
        let hasRows = false
        for (const ts of minuteTimestamps) {
            const trades = assets.map((_, assetIndex) => rowsFn(pubkey, assetIndex, ts))
            if (trades.some(rows => rows === null))
                continue
            hasRows = true
            nodeData[key][ts] = {assetsMap: plainMap, trades}
        }
        if (hasRows)
            tradesManager.addSyncData(pubkey, nodeData)
    }
    return tradesManager
}

/**
 * Serialises one node's vector so two nodes can be compared byte for byte, BigInt volumes included.
 * @param {Array} result - what getConcensusData returned: one entry per minute, each a list of per-asset samples
 * @returns {string}
 */
function serialize(result) {
    return JSON.stringify(result.map(timestampData => timestampData.map(assetData =>
        assetData.map(trade => `${trade.source}|${trade.volume}|${trade.quoteVolume}`))))
}

/**
 * Runs the real selection once per node against one shared cache.
 * @param {string[]} pubkeys - cluster node pubkeys
 * @param {Asset[]} assets - assets to price
 * @param {TradesManager} tradesManager - the shared cache
 * @param {function(string): string[]} [nodeOrderFn] - the order one node's settings hold the node list in
 * @returns {Promise<string[]>} one serialised vector per node
 */
async function runEveryNode(pubkeys, assets, tradesManager, nodeOrderFn = () => pubkeys) {
    const vectors = []
    for (const pubkey of pubkeys) {
        setupContainer(nodeOrderFn(pubkey), pubkey)
        container.tradesManager = tradesManager
        vectors.push(serialize(await getConcensusData(source, baseAsset, assets, oracleTimestamp, timeframe)))
    }
    return vectors
}

/**
 * @param {Array} perAsset - the expected rows of one minute, one entry per asset
 * @returns {Array} the same minute repeated over the whole timeframe
 */
function everyMinute(perAsset) {
    return new Array(minuteTimestamps.length).fill(null).map(() => perAsset)
}

describe('every honest node computes the same vector', () => {
    test('a minute only a minority reported is skipped by every node', async () => {
        const pubkeys = makeNodes(5)
        const assets = [btc]
        //only node-00 and node-01 hold the minute 13 row: two of five is no majority, so no node computes that minute
        const tradesManager = feedCluster(pubkeys, assets, (pubkey, assetIndex, timestamp) =>
            timestamp === 13 * minute && pubkey !== pubkeys[0] && pubkey !== pubkeys[1]
                ? null
                : row('binance', '1000'))

        const vectors = await runEveryNode(pubkeys, assets, tradesManager)

        expect(new Set(vectors).size).toBe(1)
        expect(JSON.parse(vectors[0])).toEqual(new Array(4).fill(null).map(() => [['binance|1000|100000000000000']]))
    })

    test('a trade source named "-" and an absent trade source are different samples', async () => {
        const pubkeys = makeNodes(3)
        const assets = [btc]
        //an absent source is encoded as '-', and a real source '-' as '1:-'; without the length prefix the two would
        //pool, and node-00 and node-01 would make two of three for whichever spelling came first
        const tradesManager = feedCluster(pubkeys, assets, (pubkey) => {
            if (pubkey === pubkeys[0])
                return [{volume: '1000', quoteVolume, source: '-'}]
            if (pubkey === pubkeys[1])
                return [{volume: '1000', quoteVolume}]
            return [{volume: '1000', quoteVolume, source: ''}]
        })

        const vectors = await runEveryNode(pubkeys, assets, tradesManager)

        expect(new Set(vectors).size).toBe(1)
        expect(JSON.parse(vectors[0])).toEqual([])
    })

    test('an expired asset is an empty row on every node', async () => {
        const pubkeys = makeNodes(3)
        const assets = [btc, eth]
        const tradesManager = feedCluster(pubkeys, assets, (pubkey, assetIndex) => row('binance', String(1000 + assetIndex)))

        const vectors = []
        for (const pubkey of pubkeys) {
            setupContainer(pubkeys, pubkey)
            container.tradesManager = tradesManager
            //getAssets hands an expired asset over as null
            vectors.push(serialize(await getConcensusData(source, baseAsset, [btc, null], oracleTimestamp, timeframe)))
        }

        expect(new Set(vectors).size).toBe(1)
        expect(JSON.parse(vectors[0])).toEqual(everyMinute([['binance|1000|100000000000000'], []]))
    })

    test('nobody publishes anything when the only agreed samples carry no volume', async () => {
        const pubkeys = makeNodes(3)
        const assets = [btc, eth]
        //every minute reaches majority, but only on zero volumes: the masks.size === 0 exit is a cluster-wide
        //condition now, so every node returns nothing rather than a vector of zero rows
        const tradesManager = feedCluster(pubkeys, assets, (pubkey, assetIndex) =>
            row('binance', pubkey === pubkeys[2] && assetIndex === 0 ? '5' : '0'))

        const vectors = await runEveryNode(pubkeys, assets, tradesManager)

        expect(new Set(vectors).size).toBe(1)
        expect(JSON.parse(vectors[0])).toEqual([])
    })

    test('nobody publishes anything when no node has data', async () => {
        //no peer ever presents a minute, so its sync item can only resolve through the timeout: run past every
        //deadline instead of waiting 15 s on the newest one
        nowSpy.mockReturnValue(20 * minute)
        const pubkeys = makeNodes(3)
        const assets = [btc]
        const tradesManager = feedCluster(pubkeys, assets, () => null)

        const vectors = await runEveryNode(pubkeys, assets, tradesManager)

        expect(new Set(vectors).size).toBe(1)
        expect(JSON.parse(vectors[0])).toEqual([])
    })
})
