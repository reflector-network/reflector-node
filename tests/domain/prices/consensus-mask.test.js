/*eslint-disable no-undef */
const {Asset, ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')
const {getConcensusData, buildNodeMasks} = require('../../../src/domain/prices/price-manager')
const {DissentLog, dissentLog, maxTrackedEntries, warnInterval} = require('../../../src/domain/prices/dissent-log')
const logger = require('../../../src/logger')

stopTradesManagersAfterEach(TradesManager)

const minute = 60 * 1000
//inside the newest fixture minute's sync window (ts + priceSyncDelay 15 s + 25 s), as getConsensusData.test.js pins it: sync
//items then resolve through peer presentation, and a broken presentation would stall a test instead of passing it
//through a 1 ms timeout
const now = 15 * minute + 10 * 1000
const timeframe = 5 * minute
const oracleTimestamp = 15 * minute
const minuteTimestamps = [11, 12, 13, 14, 15].map(t => t * minute)
const source = 'exchanges'
const baseAsset = new Asset(2, 'USD')
const key = `${source}_${baseAsset.code}`

let nowSpy

beforeEach(() => {
    jest.clearAllMocks()
    //the dissent warning is rate-limited per (source, base, kind, member) in module state; every test starts clean
    dissentLog.clear()
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
})

afterEach(() => {
    nowSpy.mockRestore()
})

/**
 * @param {number} count - cluster size
 * @returns {string[]} node pubkeys
 */
function makeNodes(count) {
    return Array.from({length: count}, (_, i) => `node-${String(i).padStart(2, '0')}`)
}

/**
 * @param {string[]} pubkeys - cluster node pubkeys
 * @param {string} self - the node running the computation
 */
function setupContainer(pubkeys, self) {
    container.settingsManager = {
        appConfig: {publicKey: self},
        //the fixture key has to be one this node reads, or addSyncData registers no sync entry for it
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
 * Feeds rows into a fresh trades manager. `rowsFn` returns the rows one node holds for one asset at one minute: a
 * decimal volume string stands for one binance sample, an array for the rows themselves, and `null` for no row for
 * that minute at all.
 * @param {string[]} pubkeys - cluster node pubkeys
 * @param {Asset[]} assets - assets of the map
 * @param {function(string, number, number): (string|object[]|null)} rowsFn - (pubkey, assetIndex, timestamp) -> rows
 * @returns {TradesManager}
 */
function feed(pubkeys, assets, rowsFn) {
    const tm = new TradesManager()
    container.tradesManager = tm
    const plainMap = new AssetsMap(source, baseAsset, assets).toPlainObject()
    for (const pubkey of pubkeys) {
        const nodeData = {[key]: {}}
        for (const ts of minuteTimestamps) {
            const trades = assets.map((_, assetIndex) => {
                const rows = rowsFn(pubkey, assetIndex, ts)
                return typeof rows === 'string' ? [{volume: rows, quoteVolume: '100000000000000', source: 'binance'}] : rows
            })
            if (trades.some(rows => rows === null))
                continue
            nodeData[key][ts] = {assetsMap: plainMap, trades}
        }
        tm.addSyncData(pubkey, nodeData)
    }
    return tm
}

const dissentMessage = 'Nodes absent from or disagreeing with majority-agreed trades samples'

/**
 * @returns {object[]} every dissent warning the logger received during the current test
 */
function dissenterReports() {
    return logger.warn.mock.calls
        .map(call => call[0])
        .filter(arg => arg && arg.msg === dissentMessage)
}

/**
 * @returns {string[]} `kind:member` of every dissent warning the logger received during the current test, in order
 */
function warnedMembers() {
    return dissenterReports().map(report => `${report.kind}:${report.node}`)
}

/**
 * @returns {object[]} every per-call dissent record the logger received at debug during the current test
 */
function dissentRecords() {
    return logger.debug.mock.calls
        .map(call => call[0])
        .filter(arg => arg && arg.msg === dissentMessage)
}

/**
 * @param {Array} result - what getConcensusData returned
 * @returns {Array<Array<BigInt>>} the first sample's volume of every asset of every minute, undefined for an empty row
 */
function volumes(result) {
    return result.map(timestampData => timestampData.map(assetData => assetData[0]?.volume))
}

/**
 * @param {Array<BigInt>} perAsset - the expected volumes of one minute
 * @returns {Array<Array<BigInt>>} the same minute over the whole timeframe
 */
function everyMinute(perAsset) {
    return minuteTimestamps.map(() => perAsset)
}

describe('buildNodeMasks', () => {
    test('masks are BigInt powers of two and stay distinct past 32 nodes', () => {
        const pubkeys = makeNodes(40)
        const masks = buildNodeMasks(pubkeys.map(pubkey => ({pubkey})))

        expect(masks).toHaveLength(40)
        expect(masks[0].mask).toBe(1n)
        expect(masks[31].mask).toBe(1n << 31n)
        expect(masks[32].mask).toBe(1n << 32n)
        expect(masks[39].mask).toBe(1n << 39n)
        expect(new Set(masks.map(m => m.mask)).size).toBe(40)
    })

    test('masks stay exact past 53 nodes, where a Number power of two stops being an integer bit', () => {
        const pubkeys = makeNodes(60)
        const masks = buildNodeMasks(pubkeys.map(pubkey => ({pubkey})))

        expect(masks.map(m => m.pubkey)).toEqual(pubkeys)
        expect(masks[53].mask).toBe(1n << 53n)
        expect(masks[59].mask).toBe(1n << 59n)
        //sixty distinct bits OR together into sixty ones exactly
        expect(masks.reduce((all, {mask}) => all | mask, 0n)).toBe((1n << 60n) - 1n)
    })
})

/**
 * @returns {Array<{bestMask: string, occurrences: number, nodes: string}>} every best-mask choice the logger received
 */
function bestMasks() {
    return logger.debug.mock.calls
        .map(call => call[0])
        .filter(arg => arg && arg.msg === 'Best matching mask found')
}

describe('getConcensusData agreement tally past 32 and 53 nodes', () => {
    const assets = [new Asset(2, 'BTC'), new Asset(2, 'ETH'), new Asset(2, 'XLM')]

    test.each([
        [40, 'node-32', 'node-39'],
        [60, 'node-33', 'node-55']
    ])('%i nodes: the sets missing %s and %s stay apart from the full set', async (count, first, second) => {
        const pubkeys = makeNodes(count)
        setupContainer(pubkeys, pubkeys[0])
        //with Number masks every bit past 31 aliases onto a low one and all three sets OR into -1: one tally key, and
        //the filter would keep every asset. With exact masks the three sets tie at five each, the first one seen (BTC,
        //without `first`) wins, and ETH, whose set lacks `second` but holds `first`, does not cover it.
        feed(pubkeys, assets, (pubkey, assetIndex) =>
            (pubkey === first && assetIndex === 0) || (pubkey === second && assetIndex === 1) ? '1' : String(1000 + assetIndex))

        const result = await getConcensusData(source, baseAsset, assets, oracleTimestamp, timeframe)

        expect(volumes(result)).toEqual(everyMinute([1000n, undefined, 1002n]))
        expect(bestMasks()).toHaveLength(1)
        expect(bestMasks()[0].occurrences).toBe(5)
        expect(bestMasks()[0].nodes.split(', ').sort()).toEqual(pubkeys.filter(p => p !== first))
        //both report a different volume for an asset this node holds a sample for: mismatched, not missing
        expect(dissentRecords()).toHaveLength(1)
        expect(dissentRecords()[0]).toMatchObject({missing: [], mismatched: [first, second], selfDissented: false})
        expect(warnedMembers()).toEqual([`mismatched:${first}`, `mismatched:${second}`])
    })
})

describe('getConcensusData past 32 and 53 assets', () => {
    test.each([33, 54])('%i assets: a peer differing on the last asset drops only that asset', async (count) => {
        const manyAssets = Array.from({length: count}, (_, i) => new Asset(2, `A${i}`))
        const pubkeys = makeNodes(5)
        const dissenter = pubkeys[4]
        setupContainer(pubkeys, pubkeys[0])
        feed(pubkeys, manyAssets, (pubkey, assetIndex) =>
            pubkey === dissenter && assetIndex === count - 1 ? '1' : String(1000 + assetIndex))

        const result = await getConcensusData(source, baseAsset, manyAssets, oracleTimestamp, timeframe)

        //the full node set agrees on every other asset, so it is the most frequent set, and the last asset's set
        //(without the dissenter) does not cover it
        expect(volumes(result)).toEqual(everyMinute(manyAssets.map((_, i) => i === count - 1 ? undefined : BigInt(1000 + i))))
        expect(dissentRecords()[0]).toMatchObject({missing: [], mismatched: [dissenter], selfDissented: false})
        expect(warnedMembers()).toEqual([`mismatched:${dissenter}`])
    })
})

describe('getConcensusData mask selection', () => {
    const assets = [new Asset(2, 'BTC'), new Asset(2, 'ETH'), new Asset(2, 'XLM')]

    test('an asset one peer disagrees on is dropped when the rest agree on everything else', async () => {
        const pubkeys = makeNodes(5)
        const [self, , , , dissenter] = pubkeys
        setupContainer(pubkeys, self)
        //the dissenter agrees on BTC and ETH and reports a different volume for XLM
        feed(pubkeys, assets, (pubkey, assetIndex) =>
            pubkey === dissenter && assetIndex === 2 ? '999' : String(1000 + assetIndex))

        const result = await getConcensusData(source, baseAsset, assets, oracleTimestamp, timeframe)

        //the full node set agrees on BTC and ETH (ten samples), XLM only without the dissenter (five): XLM does not
        //cover the most frequent set, so the whole group drops it
        expect(volumes(result)).toEqual(everyMinute([1000n, 1001n, undefined]))
        for (const timestampData of result) {
            expect(timestampData.map(assetData => assetData.length)).toEqual([1, 1, 0])
            for (const assetData of timestampData.slice(0, 2)) {
                //the agreement bookkeeping never leaves the function
                expect(Object.keys(assetData[0]).sort()).toEqual(['quoteVolume', 'source', 'volume'])
                expect(assetData[0].source).toBe('binance')
            }
        }
        expect(dissentRecords()[0]).toMatchObject({missing: [], mismatched: [dissenter], selfDissented: false})
        expect(warnedMembers()).toEqual([`mismatched:${dissenter}`])
    })

    test('a peer that disagrees on most samples does not drop the rest either, and is named in the log', async () => {
        const pubkeys = makeNodes(5)
        const [self, nodeB] = pubkeys
        setupContainer(pubkeys, self)
        //nodeB agrees on BTC and differs on ETH and XLM. Ordering masks by node count would make the all-nodes mask of
        //BTC the winner and discard ETH and XLM cluster-wide; any mask selection at all discards something here.
        feed(pubkeys, assets, (pubkey, assetIndex) =>
            pubkey === nodeB && assetIndex !== 0 ? '777' : String(1000 + assetIndex))

        const result = await getConcensusData(source, baseAsset, assets, oracleTimestamp, timeframe)

        expect(volumes(result)).toEqual(everyMinute([1000n, 1001n, 1002n]))
        for (const timestampData of result)
            for (const assetData of timestampData)
                expect(assetData).toHaveLength(1)
        //nothing is dropped, but the disagreement is still visible to an operator
        expect(dissentRecords()[0]).toMatchObject({missing: [], mismatched: [nodeB], equivocating: [], selfDissented: false})
        expect(warnedMembers()).toEqual([`mismatched:${nodeB}`])
    })

    test('of two incomparable agreement sets only the first one seen survives, and every dissenter is named', async () => {
        const pubkeys = makeNodes(5)
        const [self, nodeB, nodeC, nodeD, nodeE] = pubkeys
        setupContainer(pubkeys, self)
        //two incomparable agreement sets: BTC is agreed by {self, B, C} and ETH by {self, D, E}, both a bare majority
        //of five, while XLM is agreed by everyone. All three occur five times; the first one seen, BTC's, wins, so ETH
        //is dropped and XLM, agreed by everyone, covers it.
        feed(pubkeys, assets, (pubkey, assetIndex) => {
            if (assetIndex === 0 && (pubkey === nodeD || pubkey === nodeE))
                return '111'
            if (assetIndex === 1 && (pubkey === nodeB || pubkey === nodeC))
                return '222'
            return String(1000 + assetIndex)
        })

        const result = await getConcensusData(source, baseAsset, assets, oracleTimestamp, timeframe)

        expect(volumes(result)).toEqual(everyMinute([1000n, undefined, 1002n]))
        for (const timestampData of result)
            expect(timestampData.map(assetData => assetData.length)).toEqual([1, 0, 1])
        expect(dissentRecords()[0]).toMatchObject({missing: [], mismatched: [nodeB, nodeC, nodeD, nodeE], equivocating: []})
        expect(warnedMembers()).toEqual([nodeB, nodeC, nodeD, nodeE].map(node => `mismatched:${node}`))
    })

    test('a node whose own samples fail the majority keeps only what it agrees on', async () => {
        const pubkeys = makeNodes(5)
        const [, nodeB] = pubkeys
        //the dissenter itself runs the computation. Its own data is its source of truth: its ETH and XLM samples have
        //no majority, so it drops them and never takes the other four's values instead. It then differs from its
        //peers, which keep all three assets, and does not sign their transaction.
        setupContainer(pubkeys, nodeB)
        feed(pubkeys, assets, (pubkey, assetIndex) =>
            pubkey === nodeB && assetIndex !== 0 ? '777' : String(1000 + assetIndex))

        const result = await getConcensusData(source, baseAsset, assets, oracleTimestamp, timeframe)

        expect(volumes(result)).toEqual(everyMinute([1000n, undefined, undefined]))
        for (const timestampData of result)
            expect(timestampData.map(assetData => assetData.length)).toEqual([1, 0, 0])
        //from this node's side every peer disagrees with its own ETH and XLM samples
        expect(dissentRecords()[0]).toMatchObject({missing: [], mismatched: pubkeys.filter(p => p !== nodeB), selfDissented: false})
    })

    test('the trace line names the members in pubkey order and carries no BigInt masks', async () => {
        const pubkeys = makeNodes(5)
        //this node holds the node list in reverse order; the bit order, and so the trace, follows the sorted pubkeys
        setupContainer(pubkeys.slice().reverse(), pubkeys[0])
        feed(pubkeys, [assets[0]], () => '4200')

        await getConcensusData(source, baseAsset, [assets[0]], oracleTimestamp, timeframe)

        const traces = logger.trace.mock.calls.map(call => call[0]).filter(arg => arg && arg.msg === 'Getting concensus data')
        expect(traces).toHaveLength(1)
        expect(traces[0].nodes).toEqual(pubkeys)
    })

    test('a 40-node cluster agrees without mask aliasing', async () => {
        const pubkeys = makeNodes(40)
        setupContainer(pubkeys, pubkeys[0])
        //nodes at index 32 and above must set their own bits, not alias onto index 0 and up
        feed(pubkeys, [assets[0]], () => '4200')

        const result = await getConcensusData(source, baseAsset, [assets[0]], oracleTimestamp, timeframe)

        expect(volumes(result)).toEqual(everyMinute([4200n]))
        //everyone agreed on everything: nothing to report, at warn or at debug
        expect(dissenterReports()).toHaveLength(0)
        expect(dissentRecords()).toHaveLength(0)
    })
})

describe('the dissent warning is rate-limited per member', () => {
    const assets = [new Asset(2, 'BTC'), new Asset(2, 'ETH'), new Asset(2, 'XLM')]

    /**
     * @param {Array} result - what getConcensusData returned
     * @returns {string} the vector byte for byte
     */
    function serialize(result) {
        return JSON.stringify(result.map(timestampData => timestampData.map(assetData =>
            assetData.map(trade => `${trade.source}|${trade.volume}|${trade.quoteVolume}`))))
    }

    /**
     * @returns {Promise<string>} the serialised vector of one call
     */
    async function compute() {
        return serialize(await getConcensusData(source, baseAsset, assets, oracleTimestamp, timeframe))
    }

    test('a repeated dissent warns once, logs every call at debug, and never changes the vector', async () => {
        const pubkeys = makeNodes(5)
        setupContainer(pubkeys, pubkeys[0])
        feed(pubkeys, assets, (pubkey, assetIndex) => pubkey === 'node-01' && assetIndex !== 0 ? '777' : String(1000 + assetIndex))

        const warned = await compute()
        const throttled = [await compute(), await compute()]
        expect(warnedMembers()).toEqual(['mismatched:node-01'])
        expect(dissentRecords()).toHaveLength(3)

        dissentLog.clear()
        const unthrottled = await compute()
        expect(warnedMembers()).toEqual(['mismatched:node-01', 'mismatched:node-01'])
        expect(dissenterReports()[1].suppressed).toBe(0)

        //the rate limit is log-only: the vector is the same whether the warning went out or not
        expect(throttled).toEqual([warned, warned])
        expect(unthrottled).toBe(warned)
        expect(JSON.parse(warned)).toEqual(minuteTimestamps.map(() =>
            [['binance|1000|100000000000000'], ['binance|1001|100000000000000'], ['binance|1002|100000000000000']]))
    })

    test('a member that starts dissenting warns at once, and one already warned about stays folded', async () => {
        const pubkeys = makeNodes(5)
        setupContainer(pubkeys, pubkeys[0])
        feed(pubkeys, assets, (pubkey, assetIndex) => pubkey === 'node-01' && assetIndex !== 0 ? '777' : String(1000 + assetIndex))
        await compute()
        await compute()
        //same source and base: node-01 keeps dissenting and node-04 starts
        feed(pubkeys, assets, (pubkey, assetIndex) => {
            if (pubkey === 'node-01' && assetIndex !== 0)
                return '777'
            return pubkey === 'node-04' && assetIndex === 2 ? '999' : String(1000 + assetIndex)
        })
        await compute()

        expect(dissenterReports()).toEqual([
            expect.objectContaining({kind: 'mismatched', node: 'node-01', suppressed: 0}),
            expect.objectContaining({kind: 'mismatched', node: 'node-04', suppressed: 0})
        ])
    })

    test('the same member warns again once the interval has passed, with the calls it folded', async () => {
        const pubkeys = makeNodes(5)
        setupContainer(pubkeys, pubkeys[0])
        feed(pubkeys, assets, (pubkey, assetIndex) => pubkey === 'node-01' && assetIndex !== 0 ? '777' : String(1000 + assetIndex))
        await compute()
        nowSpy.mockReturnValue(now + warnInterval - 1)
        await compute()
        expect(dissenterReports()).toHaveLength(1)
        nowSpy.mockReturnValue(now + warnInterval)
        await compute()

        expect(dissenterReports()).toEqual([
            expect.objectContaining({kind: 'mismatched', node: 'node-01', suppressed: 0}),
            expect.objectContaining({kind: 'mismatched', node: 'node-01', suppressed: 1})
        ])
    })

    /**
     * @param {string} pairSource - data source of the record
     * @param {object} [lists] - missing, mismatched and equivocating members
     * @returns {object} a dissent record for that source
     */
    function record(pairSource, lists = {missing: ['node-01']}) {
        return {source: pairSource, base: 'USD', missing: [], mismatched: [], equivocating: [], self: 'node-00', ...lists}
    }

    test('alternating per-asset dissent stays at one warning per member and interval', () => {
        //a review scenario: 7 nodes, one of them offline, 1000 subscriptions priced every minute with two
        //legs each on one (source, base) pair, and a second peer dissenting on every other leg. The per-record limit
        //this replaces warned on every call it alternated: 120 000 lines an hour.
        const log = new DissentLog()
        let t = 0
        for (let m = 0; m < 60; m++) {
            t = m * 60 * 1000 + 20000
            for (let subscription = 0; subscription < 1000; subscription++)
                for (let leg = 0; leg < 2; leg++) {
                    t += 2
                    log.report(record('exchanges', {missing: ['G-OFFLINE'], mismatched: leg ? ['G-B'] : []}), t)
                }
        }

        //each member warns at minutes 0, 10, 20, 30, 40 and 50 of the hour
        expect(logger.warn).toHaveBeenCalledTimes(12)
        expect(warnedMembers()).toEqual(new Array(6).fill(['missing:G-OFFLINE', 'mismatched:G-B']).flat())
        expect(dissentRecords()).toHaveLength(120000)
    })

    test('pairs, kinds and members are rate-limited independently', () => {
        const log = new DissentLog()

        expect(log.report(record('exchanges'), 0)).toBe(1)
        expect(log.report(record('forex'), 1)).toBe(1)
        expect(log.report(record('exchanges', {mismatched: ['node-01']}), 2)).toBe(1)
        expect(log.report(record('exchanges', {equivocating: ['node-01']}), 3)).toBe(1)
        expect(log.report(record('exchanges', {missing: ['node-01', 'node-02']}), 4)).toBe(1)
        expect(log.report(record('exchanges'), 5)).toBe(0)
        expect(log.report(record('forex'), 6)).toBe(0)
        expect(logger.warn).toHaveBeenCalledTimes(5)
    })

    test('a member that stops dissenting reports the calls it folded once its interval has passed', () => {
        const log = new DissentLog()
        log.report(record('exchanges'), 0)
        log.report(record('exchanges'), 1)
        log.report(record('exchanges'), 2)
        expect(logger.warn).toHaveBeenCalledTimes(1)

        //calls without dissent keep coming; the member was last seen at 2, and the sweep looks once a minute
        log.report(record('exchanges', {missing: []}), 1 + warnInterval)
        expect(logger.warn).toHaveBeenCalledTimes(1)
        log.report(record('exchanges', {missing: []}), 1 + warnInterval + 60 * 1000)

        //the closing line is marked final, so it cannot be read as "still dissenting, 2 calls folded"
        expect(dissenterReports()).toEqual([
            expect.objectContaining({kind: 'missing', node: 'node-01', suppressed: 0, final: false}),
            expect.objectContaining({kind: 'missing', node: 'node-01', suppressed: 2, final: true})
        ])
        expect(log.size).toBe(0)
    })

    test('a member still dissenting when its interval passes warns again, not marked final', () => {
        const log = new DissentLog()
        log.report(record('exchanges'), 0)
        log.report(record('exchanges'), 1)
        log.report(record('exchanges'), warnInterval)

        expect(dissenterReports()).toEqual([
            expect.objectContaining({kind: 'missing', node: 'node-01', suppressed: 0, final: false}),
            expect.objectContaining({kind: 'missing', node: 'node-01', suppressed: 1, final: false})
        ])
    })

    /**
     * Fills a fresh log to the cap with members n0, n1, ... warned at times 0, 1, ...
     * @returns {DissentLog}
     */
    function fullLog() {
        const log = new DissentLog()
        for (let i = 0; i < maxTrackedEntries; i++)
            log.report(record('exchanges', {missing: [`n${i}`]}), i)
        expect(log.size).toBe(maxTrackedEntries)
        return log
    }

    test('a full map counts a new member instead of warning while every entry is inside its interval', () => {
        const log = fullLog()
        logger.warn.mockClear()

        expect(log.report(record('exchanges', {missing: ['x']}), maxTrackedEntries)).toBe(0)
        expect(log.report(record('exchanges', {missing: ['y']}), maxTrackedEntries + 1)).toBe(0)

        //the first untracked sighting reports the overflow at once, the next one is counted into the following line
        expect(logger.warn.mock.calls.map(call => call[0])).toEqual([
            {msg: dissentMessage, overflow: 1, tracked: maxTrackedEntries}
        ])
        expect(log.size).toBe(maxTrackedEntries)

        //every tracked member keeps dissenting, so none is swept, and the counted sighting goes out after the interval
        for (let i = 0; i < maxTrackedEntries; i++)
            log.report(record('exchanges', {missing: [`n${i}`]}), maxTrackedEntries + 2)
        logger.warn.mockClear()
        log.report(record('exchanges', {missing: []}), maxTrackedEntries + warnInterval)
        expect(logger.warn.mock.calls.map(call => call[0])).toContainEqual({msg: dissentMessage, overflow: 1, tracked: expect.any(Number)})
    })

    test('a full map lets a new member replace the least recently warned entry once its interval has passed', () => {
        const log = fullLog()
        //every member is seen again just before the interval ends, so the sweep keeps them all; n1 folds one call
        for (let i = 0; i < maxTrackedEntries; i++)
            log.report(record('exchanges', {missing: [`n${i}`]}), warnInterval - 1)
        //n0 warns again, which makes it the most recently warned; n1, warned at 1, is now the least recent
        log.report(record('exchanges', {missing: ['n0']}), warnInterval)
        logger.warn.mockClear()

        expect(log.report(record('exchanges', {missing: ['z']}), warnInterval + 2)).toBe(1)

        //n1 is evicted with a final line carrying what it folded, and z warns in its place
        expect(logger.warn.mock.calls.map(call => call[0])).toEqual([
            expect.objectContaining({kind: 'missing', node: 'n1', suppressed: 1, final: true}),
            expect.objectContaining({kind: 'missing', node: 'z', suppressed: 0, final: false})
        ])
        expect(log.size).toBe(maxTrackedEntries)
        //n0 is still tracked: seen again within its new interval, it folds instead of warning
        expect(log.report(record('exchanges', {missing: ['n0']}), warnInterval + 3)).toBe(0)
    })

    test('an over-cap workload stays throttled: 2 400 live entries warn once per tracked entry per interval', () => {
        //40 (source, base) pairs x 20 members x 3 kinds, every member dissenting every way on every pair, each pair
        //priced once a minute for an hour. A least-recently-seen eviction evicted exactly the entry due next, so
        //every sighting started a fresh entry and warned: 720 000 lines an hour, more than no limiter at all.
        const members = Array.from({length: 20}, (_, i) => `M${i}`)
        const log = new DissentLog()
        for (let m = 0; m < 60; m++)
            for (let pair = 0; pair < 40; pair++)
                log.report({source: `s${pair}`, base: 'USD', missing: members, mismatched: members, equivocating: members, self: 'M0'},
                    m * 60 * 1000 + pair * 100)

        const lines = logger.warn.mock.calls.map(call => call[0])
        //2 048 tracked entries warn in minutes 0, 10, 20, 30, 40 and 50; the other 352 are counted in one line each time
        expect(lines.filter(line => line.overflow === undefined)).toHaveLength(6 * maxTrackedEntries)
        expect(lines.filter(line => line.overflow !== undefined)).toEqual(new Array(6).fill(null).map((_, i) =>
            ({msg: dissentMessage, overflow: i === 0 ? 1 : 3520, tracked: maxTrackedEntries})))
        expect(lines).toHaveLength(12294)
        expect(log.size).toBe(maxTrackedEntries)
    })

})
