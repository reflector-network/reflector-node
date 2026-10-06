/*eslint-disable no-undef */
const {Asset, ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const Trades = require('../../../src/domain/prices/trades-cache')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')

stopTradesManagersAfterEach(TradesManager)

const minute = 60 * 1000
const heartbeat = 2 * 60 * 60 * 1000 //120 minutes
const self = 'self-node'
const peer = 'peer-a'

beforeEach(() => {
    //TradesManager arms a recurring cleanup timer and every sync item arms its own; keep them all off the real clock
    jest.useFakeTimers()
    container.settingsManager = {
        appConfig: {publicKey: self},
        config: {nodes: new Map([[self, {pubkey: self}], [peer, {pubkey: peer}]])},
        nodes: new Map([[self, {pubkey: self}], [peer, {pubkey: peer}]]),
        getPriceHeartbeat: () => heartbeat
    }
})

afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
})

/**
 * @param {string} baseCode - base asset code of the map
 * @returns {AssetsMap}
 */
function makeMap(baseCode) {
    return new AssetsMap('exchanges', new Asset(2, baseCode), [new Asset(2, 'BTC')])
}

/**
 * @returns {Array.<Array.<object>>} one row with one entry
 */
function row() {
    return [[{volume: '1', quoteVolume: '2', source: 'binance'}]]
}

/**
 * Lists one oracle contract on exchanges/USD, which makes `exchanges_USD` the one key this node reads
 */
function useLocalKey() {
    container.settingsManager.config.contracts = new Map([
        ['oracle', {contractId: 'oracle', type: ContractTypes.ORACLE, dataSource: 'exchanges', baseAsset: new Asset(2, 'USD')}]
    ])
    container.settingsManager.getAssets = () => [new Asset(2, 'BTC')]
}

/**
 * @param {string} code - base asset code, which spells the key `exchanges_<code>`
 * @returns {object} one raw cache item as a peer serialises it
 */
function peerItem(code) {
    return {
        assetsMap: {source: 'exchanges', baseAsset: {type: 2, code}, assets: [{type: 2, code: 'BTC'}]},
        trades: [[{volume: '1', quoteVolume: '2', source: 'binance'}]]
    }
}

/**
 * @param {TradesManager} tm - trades manager
 * @returns {number} sync items held across every timestamp and key
 */
function countSyncItems(tm) {
    let count = 0
    for (const keyData of tm.__timestamps.values())
        count += keyData.size
    return count
}

describe('cache bounds', () => {
    test('a peer cannot hold more than the key cap', () => {
        const trades = new Trades()
        for (let i = 0; i < 40; i++)
            trades.push(peer, `exchanges_C${i}`, makeMap(`C${i}`), 10 * minute, row())

        expect(trades.__trades.get(peer).getKeys()).toHaveLength(32)
        expect(trades.__trades.get(peer).getKeys()).not.toContain('exchanges_C0')
        expect(trades.__trades.get(peer).getKeys()).toContain('exchanges_C39')
    })

    test('a full cache evicts the stalest key, never a live key that happens to be the oldest inserted', () => {
        const trades = new Trades()
        //the live key arrives first, so it is the oldest INSERTED key for the whole run
        trades.push(peer, 'exchanges_LIVE', makeMap('LIVE'), 100 * minute, row())
        //31 keys that stopped receiving data long ago: a contract removed from the config, say
        for (let i = 1; i < 32; i++)
            trades.push(peer, `exchanges_D${String(i).padStart(2, '0')}`, makeMap(`D${i}`), 50 * minute, row())
        trades.push(peer, 'exchanges_LIVE', makeMap('LIVE'), 101 * minute, row())
        const cache = trades.__trades.get(peer)
        expect(cache.getKeys()).toHaveLength(32)

        trades.push(peer, 'exchanges_NEW', makeMap('NEW'), 101 * minute, row())

        expect(cache.getKeys()).toHaveLength(32)
        expect(cache.getKeys()).toContain('exchanges_LIVE')
        expect(cache.getKeys()).toContain('exchanges_NEW')
        //every dead key has the same newest timestamp, so the tie falls to the key string, not to arrival order
        expect(cache.getKeys()).not.toContain('exchanges_D01')
        expect(cache.getKeys()).toContain('exchanges_D02')
        //the live key keeps its history
        expect(cache.getFirstTimestamp('exchanges_LIVE')).toBe(100 * minute)
        expect(cache.getLastTimestamp('exchanges_LIVE')).toBe(101 * minute)
    })

    test('a new key staler than every key held does not displace one of them', () => {
        const trades = new Trades()
        for (let i = 0; i < 32; i++)
            trades.push(peer, `exchanges_F${String(i).padStart(2, '0')}`, makeMap(`F${i}`), 100 * minute, row())

        const item = trades.push(peer, 'exchanges_OLD', makeMap('OLD'), 50 * minute, row())

        const keys = trades.__trades.get(peer).getKeys()
        expect(keys).toHaveLength(32)
        expect(keys).not.toContain('exchanges_OLD')
        expect(keys).toContain('exchanges_F00')
        //the caller still gets its item back, as loadTradesDataForSource broadcasts it
        expect(item.trades).toEqual([[{volume: 1n, quoteVolume: 2n, source: 'binance'}]])
    })

    test('key eviction does not depend on the order the keys arrived in', () => {
        const keys = []
        for (let i = 0; i < 40; i++)
            keys.push({key: `exchanges_K${String(i).padStart(2, '0')}`, ts: (10 + (i % 7)) * minute})
        const forward = new Trades()
        for (const {key, ts} of keys)
            forward.push(peer, key, makeMap(key), ts, row())
        //the same final set of admitted keys has to survive whatever order the peer used, so push the tail first
        const reordered = new Trades()
        for (const {key, ts} of [...keys.slice(20), ...keys.slice(0, 20)])
            reordered.push(peer, key, makeMap(key), ts, row())

        expect(forward.__trades.get(peer).getKeys()).toHaveLength(32)
        expect(reordered.__trades.get(peer).getKeys()).toHaveLength(32)
        //the 32 keys with the newest data survive in both runs: the six keys at 10 min go, then the two smallest key
        //strings among the six at 11 min
        const kept = [...forward.__trades.get(peer).getKeys()].sort()
        expect([...reordered.__trades.get(peer).getKeys()].sort()).toEqual(kept)
        for (const evicted of ['K00', 'K07', 'K14', 'K21', 'K28', 'K35', 'K01', 'K08'])
            expect(kept).not.toContain(`exchanges_${evicted}`)
        expect(kept).toContain('exchanges_K15')
        expect(kept).toContain('exchanges_K06')
        expect(kept).toContain('exchanges_K39')
    })

    test('timestamps outside the heartbeat window are dropped even below the count cap', () => {
        const trades = new Trades()
        const key = 'exchanges_USD'
        trades.push(peer, key, makeMap('USD'), 10 * minute, row())
        trades.push(peer, key, makeMap('USD'), 200 * minute, row())

        //10 min is more than 120 minutes behind 200 min, so it is outside the window
        expect(trades.__trades.get(peer).getFirstTimestamp(key)).toBe(200 * minute)
    })

    test('no more timestamps per key than the window allows', () => {
        const trades = new Trades()
        const key = 'exchanges_USD'
        for (let i = 0; i < 200; i++)
            trades.push(peer, key, makeMap('USD'), (1000 + i) * minute, row())

        const cache = trades.__trades.get(peer)
        expect(cache.getLastTimestamp(key) - cache.getFirstTimestamp(key)).toBeLessThanOrEqual(heartbeat)
        expect(cache.getLastTimestamp(key)).toBe(1199 * minute)
        expect(cache.getFirstTimestamp(key)).toBe(1080 * minute)
    })

    test('the timestamp sync map is capped and evicts the oldest timestamp', () => {
        const tm = new TradesManager()
        for (let i = 0; i < 600; i++)
            tm.__getOrAddTimestampSync('exchanges_USD', (10_000 + i) * minute)

        //at the 2 h default heartbeat the derived cap is the floor, 512
        expect(tm.__timestamps.size).toBe(512)
        expect(tm.__timestamps.has(10_000 * minute)).toBe(false)
        expect(tm.__timestamps.has(10_087 * minute)).toBe(false)
        expect(tm.__timestamps.has(10_088 * minute)).toBe(true)
        expect(tm.__timestamps.has(10_599 * minute)).toBe(true)
    })

    test('the sync map evicts by timestamp, not by the order a peer chose', () => {
        const tm = new TradesManager()
        //the newest timestamps arrive first; insertion-order eviction would throw them out
        for (let i = 599; i >= 0; i--)
            tm.__getOrAddTimestampSync('exchanges_USD', (10_000 + i) * minute)

        expect(tm.__timestamps.size).toBe(512)
        expect(tm.__timestamps.has(10_599 * minute)).toBe(true)
        //each new, older timestamp evicted the oldest one held, so the last one added is the only survivor below the top
        expect(tm.__timestamps.has(10_000 * minute)).toBe(true)
        expect(tm.__timestamps.has(10_001 * minute)).toBe(false)
    })

    test('an evicted sync entry releases whoever is waiting on it', async () => {
        const tm = new TradesManager()
        const first = tm.__getOrAddTimestampSync('exchanges_USD', 10_000 * minute)
        for (let i = 1; i <= 512; i++)
            tm.__getOrAddTimestampSync('exchanges_USD', (10_000 + i) * minute)

        expect(tm.__timestamps.has(10_000 * minute)).toBe(false)
        expect(first.isProcessed).toBe(true)
        await expect(first.readyPromise).resolves.toBeUndefined()
    })

    test('the cap follows priceHeartbeat rather than a fixed number', () => {
        //12 h heartbeat: 720 minutes of legitimate data, which a fixed 512 would reject
        container.settingsManager.getPriceHeartbeat = () => 12 * 60 * 60 * 1000
        const tm = new TradesManager()
        for (let i = 0; i < 1500; i++)
            tm.__getOrAddTimestampSync('exchanges_USD', (10_000 + i) * minute)

        //twice the 720-minute window
        expect(tm.__timestamps.size).toBe(1440)
        expect(tm.__timestamps.has(10_059 * minute)).toBe(false)
        expect(tm.__timestamps.has(10_060 * minute)).toBe(true)
    })

    test('the read path never throws when the sync map is full', () => {
        const tm = new TradesManager()
        for (let i = 0; i < 512; i++)
            tm.__getOrAddTimestampSync('exchanges_USD', (10_000 + i) * minute)

        //getTradesData reaches __getOrAddTimestampSync outside any try; a throw here would kill the tick for every
        //contract on every node, permanently
        expect(() => tm.__getOrAddTimestampSync('exchanges_USD', 99_999 * minute)).not.toThrow()
        expect(tm.__timestamps.size).toBe(512)
        expect(tm.__timestamps.has(99_999 * minute)).toBe(true)
    })

    test('the cleanup worker drops timestamp entries the cache has moved past', () => {
        jest.useFakeTimers({now: 500 * minute})
        const tm = new TradesManager()
        container.tradesManager = tm
        //the current node has data from 400 minutes onward, so anything older is dead weight
        tm.__trades.push(self, 'exchanges_USD', makeMap('USD'), 400 * minute, row())
        tm.__getOrAddTimestampSync('exchanges_USD', 300 * minute)
        tm.__getOrAddTimestampSync('exchanges_USD', 400 * minute)
        expect(tm.__timestamps.size).toBe(2)

        jest.advanceTimersByTime(minute)

        expect(tm.__timestamps.has(300 * minute)).toBe(false)
        expect(tm.__timestamps.has(400 * minute)).toBe(true)
    })

    test('the cleanup worker resolves an entry before it drops it', () => {
        //the item's own deadline is its minute + 40 s (priceSyncDelay + the sync wait): opened 30 s before its minute,
        //it is still waiting when the worker runs a minute after the manager starts, 20 s before that deadline
        jest.useFakeTimers({now: 498 * minute - 30_000})
        const tm = new TradesManager()
        container.tradesManager = tm
        tm.__trades.push(self, 'exchanges_USD', makeMap('USD'), 499 * minute, row())
        const stale = tm.__getOrAddTimestampSync('exchanges_USD', 498 * minute)
        expect(stale.isProcessed).toBe(false)

        jest.advanceTimersByTime(minute)

        expect(tm.__timestamps.has(498 * minute)).toBe(false)
        expect(stale.isProcessed).toBe(true)
        //and its own timer went with it: the only timer left is the re-armed cleanup worker
        expect(jest.getTimerCount()).toBe(1)
    })

    test('a non-numeric heartbeat still leaves the sync map capped at the floor', () => {
        container.settingsManager.getPriceHeartbeat = () => 'not a number'
        const tm = new TradesManager()
        for (let i = 0; i < 600; i++)
            tm.__getOrAddTimestampSync('exchanges_USD', (10_000 + i) * minute)

        expect(tm.__timestamps.size).toBe(512)
    })

    test('a peer flooding fresh keys arms no sync item and no timer for them', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        useLocalKey()
        const tm = new TradesManager()
        container.tradesManager = tm
        //a sustained flood: 50 frames of 64 fresh keys (maxSyncKeys) x 120 in-window minutes, newest minute first
        for (let frame = 0; frame < 50; frame++) {
            const data = {}
            for (let k = 0; k < 64; k++) {
                const code = `J${frame}_${k}`
                data[`exchanges_${code}`] = {}
                for (let i = 0; i < 120; i++)
                    data[`exchanges_${code}`][now - i * minute] = peerItem(code)
            }
            tm.addSyncData(peer, data)
        }
        //and one frame of the key this node reads
        const local = {exchanges_USD: {}}
        for (let i = 0; i < 120; i++)
            local.exchanges_USD[now - i * minute] = peerItem('USD')
        tm.addSyncData(peer, local)

        //the peer's own cache stays at its key cap and keeps the key that is read
        const peerKeys = tm.__trades.__trades.get(peer).getKeys()
        expect(peerKeys).toHaveLength(32)
        expect(peerKeys).toContain('exchanges_USD')
        //one sync item per minute of the read key and none for the 384,000 junk items; without the filter this is
        //384,120 items and 384,121 armed timers
        expect(tm.__timestamps.size).toBe(120)
        expect(countSyncItems(tm)).toBe(120)
        expect([...tm.__timestamps.values()].every(keyData => [...keyData.keys()].join() === 'exchanges_USD')).toBe(true)
        expect(jest.getTimerCount()).toBe(121) //120 sync items and the cleanup worker
        //the payload input is untouched: the peer's row for the read key is there to read
        expect(tm.__trades.getTradesData('exchanges_USD', now - minute, [new Asset(2, 'BTC')]).get(peer))
            .toEqual([[{volume: 1n, quoteVolume: 2n, source: 'binance'}]])
    }, 120_000)

    test('a sync entry opened after the data arrived credits every node already holding the minute', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        //no contract lists exchanges_USD yet, so neither feed registers a sync entry for it
        container.settingsManager.config.contracts = new Map()
        container.settingsManager.getAssets = () => []
        const tm = new TradesManager()
        container.tradesManager = tm
        const ts = now - minute
        tm.addSyncData(self, {exchanges_USD: {[ts]: peerItem('USD')}})
        tm.addSyncData(peer, {exchanges_USD: {[ts]: peerItem('USD')}})
        expect(tm.__timestamps.size).toBe(0)

        //the first read opens the entry; both nodes already presented, so it resolves without waiting out the deadline
        const item = tm.__getOrAddTimestampSync('exchanges_USD', ts)

        expect(item.getDebugInfo().pubkeys.sort()).toEqual([peer, self])
        expect(item.isProcessed).toBe(true)
    })

    test('the key of a removed contract neither pins the cleanup nor stays in the cache', () => {
        const start = 100_000 * minute
        jest.useFakeTimers({now: start})
        useLocalKey()
        const tm = new TradesManager()
        container.tradesManager = tm
        //the key of a contract removed from the config: pushed once, never again
        tm.__trades.push(self, 'exchanges_DEAD', makeMap('DEAD'), start - minute, row())
        tm.__trades.push(peer, 'exchanges_DEAD', makeMap('DEAD'), start - minute, row())
        //700 minutes of honest operation on the live key
        for (let i = 0; i < 700; i++) {
            const ts = start + i * minute
            tm.__trades.push(self, 'exchanges_USD', makeMap('USD'), ts, row())
            tm.__getOrAddTimestampSync('exchanges_USD', ts)
            jest.advanceTimersByTime(minute)
        }

        //the dead key aged out of every node's cache
        expect(tm.__trades.__trades.get(self).getKeys()).toEqual(['exchanges_USD'])
        expect(tm.__trades.__trades.get(peer).getKeys()).toEqual([])
        //the cutoff follows the live key's first minute (580), not the dead key's, so the map holds one heartbeat of
        //minutes instead of sitting at its 512 cap
        expect(tm.__trades.getFirstTimestamp('exchanges_USD')).toBe(start + 580 * minute)
        expect(tm.__timestamps.size).toBe(120)
        expect(tm.__timestamps.has(start + 579 * minute)).toBe(false)
        expect(tm.__timestamps.has(start + 580 * minute)).toBe(true)
        expect(tm.__timestamps.has(start + 699 * minute)).toBe(true)
    })

    test('with no data of its own the cleanup still drops entries older than the ingest window', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        const tm = new TradesManager()
        container.tradesManager = tm
        //reads open entries whatever the cache holds; with an empty cache the first timestamp is 0 and cuts nothing
        tm.__getOrAddTimestampSync('exchanges_USD', now - 300 * minute)
        tm.__getOrAddTimestampSync('exchanges_USD', now - 10 * minute)

        jest.advanceTimersByTime(minute)

        //the horizon is now + 1 min - 120 min - 2 min
        expect(tm.__timestamps.has(now - 300 * minute)).toBe(false)
        expect(tm.__timestamps.has(now - 10 * minute)).toBe(true)
    })

    test('an infinite heartbeat falls back to the default one for every bound', () => {
        //JSON 1e400 parses to Infinity, and the shared config accepts it
        container.settingsManager.getPriceHeartbeat = () => Infinity
        const trades = new Trades()
        for (let i = 0; i < 200; i++)
            trades.push(peer, 'exchanges_USD', makeMap('USD'), (1000 + i) * minute, row())
        //trimmed exactly as at the 2 h default
        const cache = trades.__trades.get(peer)
        expect(cache.getLastTimestamp('exchanges_USD')).toBe(1199 * minute)
        expect(cache.getFirstTimestamp('exchanges_USD')).toBe(1080 * minute)

        const tm = new TradesManager()
        for (let i = 0; i < 600; i++)
            tm.__getOrAddTimestampSync('exchanges_USD', (10_000 + i) * minute)
        expect(tm.__timestamps.size).toBe(512)
    })

    test('an infinite heartbeat does not open the ingest window either', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        container.settingsManager.getPriceHeartbeat = () => Infinity
        useLocalKey()
        const tm = new TradesManager()
        container.tradesManager = tm

        tm.addSyncData(peer, {exchanges_USD: {[now - 200 * minute]: peerItem('USD'), [now - 100 * minute]: peerItem('USD')}})

        //200 minutes back is outside the default 2 h window and is rejected; 100 minutes back is kept
        const cache = tm.__trades.__trades.get(peer)
        expect(cache.getFirstTimestamp('exchanges_USD')).toBe(now - 100 * minute)
        expect(cache.getLastTimestamp('exchanges_USD')).toBe(now - 100 * minute)
    })

    test('a late sync entry credits only the nodes holding that minute of that key', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        const tm = new TradesManager()
        container.tradesManager = tm
        const ts = now - minute
        tm.__trades.push(self, 'exchanges_USD', makeMap('USD'), ts, row())
        //the peer holds the minute before, and this minute only under another key
        tm.__trades.push(peer, 'exchanges_USD', makeMap('USD'), ts - minute, row())
        tm.__trades.push(peer, 'exchanges_EUR', makeMap('EUR'), ts, row())

        const item = tm.__getOrAddTimestampSync('exchanges_USD', ts)

        //crediting the peer would resolve the read before it ever sent this minute: two of two nodes presented
        expect(item.getDebugInfo().pubkeys).toEqual([self])
        expect(item.isProcessed).toBe(false)
    })

    test('an open sync entry still records a peer while its key is briefly not read', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        useLocalKey()
        const tm = new TradesManager()
        container.tradesManager = tm
        const ts = now - minute
        //this node's own load opens the entry for the minute
        tm.__trades.push(self, 'exchanges_USD', makeMap('USD'), ts, row())
        const item = tm.__getOrAddTimestampSync('exchanges_USD', ts)
        item.add(self)
        expect(item.isProcessed).toBe(false)
        //the contract is removed, and re-added a moment later, while the peer's frame arrives
        container.settingsManager.config.contracts = new Map()

        tm.addSyncData(peer, {exchanges_USD: {[ts]: peerItem('USD')}, exchanges_EUR: {[ts]: peerItem('EUR')}})

        //the open entry records the peer and resolves through presentation, not through its deadline
        expect(item.getDebugInfo().pubkeys.sort()).toEqual([peer, self])
        expect(item.isProcessed).toBe(true)
        //and a key nobody reads still gets no entry and no timer
        expect([...tm.__timestamps.get(ts).keys()]).toEqual(['exchanges_USD'])
        expect(jest.getTimerCount()).toBe(1) //the cleanup worker; the resolved item's timer is cleared
    })
})

describe('per-peer byte budget', () => {
    const logger = require('../../../src/logger')
    const {estimateItemBytes, maxPeerCacheBytes} = Trades

    beforeEach(() => {
        //the logger mock is shared by the whole run, so a warning counted here must be one this test produced
        logger.warn.mockClear()
    })

    /**
     * A frame-shaped item: as many assets as fit in one 1 MB frame, no trades
     * @param {number} [count] - number of assets
     * @returns {AssetsMap}
     */
    function wideMap(count = 40000) {
        const assets = []
        for (let i = 0; i < count; i++)
            assets.push(new Asset(2, `A${i.toString(36)}`))
        return new AssetsMap('exchanges', new Asset(2, 'USD'), assets)
    }

    /**
     * An honest item: every asset of the map with one entry per exchange, volumes at 14 decimals
     * @param {number} assetCount - assets in the map
     * @param {number} sourceCount - trade sources per asset
     * @returns {{assetsMap: AssetsMap, trades: Array.<Array.<object>>}}
     */
    function honestItem(assetCount, sourceCount) {
        const assets = []
        const trades = []
        for (let i = 0; i < assetCount; i++) {
            assets.push(new Asset(2, `ASSET${i}`))
            const row = []
            for (let s = 0; s < sourceCount; s++)
                row.push({volume: '1234567890123456789012345', quoteVolume: '9876543210987654321098765', source: `exchange${s}`})
            trades.push(row)
        }
        return {assetsMap: new AssetsMap('exchanges', new Asset(2, 'USD'), assets), trades}
    }

    test('the estimate counts every asset, entry and character a peer can make the cache hold', () => {
        const map = new AssetsMap('exchanges', new Asset(2, 'USD'), [new Asset(2, 'BTC'), new Asset(2, 'ETH')])
        const trades = [[{volume: '12345', quoteVolume: '678', source: 'binance'}], []]

        //one item, two assets of 3 characters, one entry of 5 + 3 digits and a 7-character source, strings at 2 bytes
        expect(estimateItemBytes(map, trades)).toBe(256 + 2 * (96 + 2 * 3) + (136 + Math.ceil((5 + 3) / 2) + 2 * 7))
        expect(estimateItemBytes(map, trades)).toBe(614)
    })

    test('codes and sources are charged two bytes a character, what V8 takes for a string past Latin-1', () => {
        const estimate = (code, source) => estimateItemBytes(
            new AssetsMap('exchanges', new Asset(2, 'USD'), [{type: 2, code}]), //as validated from a peer: no length check
            [[{volume: '1', quoteVolume: '1', source}]]
        )
        const base = estimate('A', 's')

        //a CJK character costs what an ASCII one does, and every extra character two bytes, in a code or a source
        expect(estimate('\u4e00', '\u4e00')).toBe(base)
        expect(estimate('A'.repeat(81), 's')).toBe(base + 160)
        expect(estimate('A', '\u4e00'.repeat(3301))).toBe(base + 6600)
    })

    test('a peer holds no more estimated bytes than the budget, whatever keys and minutes it spreads them over', () => {
        const trades = new Trades()
        const map = wideMap()
        const itemBytes = estimateItemBytes(map, [])
        const fits = Math.floor(maxPeerCacheBytes / itemBytes)
        //32 keys x 10 minutes of frame-sized items: far past the budget, well inside the key and minute bounds
        for (let k = 0; k < 32; k++)
            for (let m = 0; m < 10; m++)
                trades.push(peer, `exchanges_K${String(k).padStart(2, '0')}`, map, (1000 + m) * minute, [])

        const cache = trades.__trades.get(peer)
        expect(itemBytes).toBe(4_157_592)
        expect(fits).toBe(24)
        expect(cache.bytes).toBe(fits * itemBytes)
        expect([...cache.getAll().values()].reduce((count, keyData) => count + keyData.size, 0)).toBe(fits)
    })

    test('the oldest items go first, ties broken by the key string, so the newest data survives', () => {
        const trades = new Trades()
        const map = wideMap()
        for (let m = 0; m < 12; m++)
            for (const key of ['exchanges_B', 'exchanges_A'])
                trades.push(peer, key, map, (1000 + m) * minute, [])
        trades.push(peer, 'exchanges_B', map, 1012 * minute, [])

        const cache = trades.__trades.get(peer)
        //24 of the 25 items fit: the one evicted is minute 1000 of exchanges_A, the smaller key of the oldest minute
        expect(cache.getFirstTimestamp('exchanges_A')).toBe(1001 * minute)
        expect(cache.getFirstTimestamp('exchanges_B')).toBe(1000 * minute)
        expect(cache.getLastTimestamp('exchanges_A')).toBe(1011 * minute)
        expect(cache.getLastTimestamp('exchanges_B')).toBe(1012 * minute)
    })

    test('an item older than everything held evicts itself rather than newer data', () => {
        const trades = new Trades()
        const map = wideMap()
        for (let m = 0; m < 24; m++)
            trades.push(peer, 'exchanges_USD', map, (1000 + m) * minute, [])
        const cache = trades.__trades.get(peer)
        expect(cache.bytes).toBe(24 * estimateItemBytes(map, []))

        trades.push(peer, 'exchanges_EUR', map, 999 * minute, [])

        expect(cache.getKeys()).toEqual(['exchanges_USD'])
        expect(cache.getFirstTimestamp('exchanges_USD')).toBe(1000 * minute)
        expect(cache.bytes).toBe(24 * estimateItemBytes(map, []))
    })

    test('the first overflow of a peer is logged once as a warning, never per frame', () => {
        const trades = new Trades()
        const map = wideMap()
        for (let m = 0; m < 30; m++)
            trades.push(peer, 'exchanges_USD', map, (1000 + m) * minute, [])

        const warnings = logger.warn.mock.calls.filter(([entry]) => entry?.msg?.startsWith('Peer trades cache exceeds its byte budget'))
        expect(warnings).toHaveLength(1)
        expect(warnings[0][0]).toEqual(expect.objectContaining({node: peer, budget: maxPeerCacheBytes}))
    })

    test('a peer item that evicts itself under the budget does not credit the peer in the sync entry', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        useLocalKey()
        const tm = new TradesManager()
        container.tradesManager = tm
        const map = wideMap()
        //the peer already holds a full budget of newer minutes on the key this node reads
        for (let m = 1; m <= 24; m++)
            tm.__trades.push(peer, 'exchanges_USD', map, now - m * minute, [])
        const ts = now - 30 * minute
        tm.__trades.push(self, 'exchanges_USD', makeMap('USD'), ts, row())
        const item = tm.__getOrAddTimestampSync('exchanges_USD', ts)
        item.add(self)

        //an item older than everything the peer holds is pushed, and evicted again at once
        tm.addSyncData(peer, {exchanges_USD: {[ts]: {assetsMap: map.toPlainObject(), trades: []}}})

        expect(tm.__trades.getNodesWithData('exchanges_USD', ts)).toEqual([self])
        expect(item.getDebugInfo().pubkeys).toEqual([self])
        expect(item.isProcessed).toBe(false)
    })

    test('this node own cache is not held to the budget', () => {
        const trades = new Trades()
        const map = wideMap()
        for (let m = 0; m < 30; m++)
            trades.push(self, 'exchanges_USD', map, (1000 + m) * minute, [])

        expect(trades.getFirstTimestamp('exchanges_USD')).toBe(1000 * minute)
        expect(trades.getLastTimestamp('exchanges_USD')).toBe(1029 * minute)
    })

    test('bytes are released when a minute is replaced, trimmed out of the window, or its key goes stale', () => {
        const trades = new Trades()
        const {assetsMap, trades: rows} = honestItem(10, 2)
        const itemBytes = estimateItemBytes(assetsMap, rows)
        trades.push(peer, 'exchanges_USD', assetsMap, 1000 * minute, rows)
        trades.push(peer, 'exchanges_USD', assetsMap, 1000 * minute, rows) //a resent minute replaces the item
        trades.push(peer, 'exchanges_EUR', assetsMap, 1000 * minute, rows)
        const cache = trades.__trades.get(peer)
        expect(cache.bytes).toBe(2 * itemBytes)

        //more than a heartbeat later: the old minute of exchanges_USD leaves the window
        trades.push(peer, 'exchanges_USD', assetsMap, 1200 * minute, rows)
        expect(cache.bytes).toBe(2 * itemBytes)

        trades.removeStaleKeys(1100 * minute)
        expect(cache.getKeys()).toEqual(['exchanges_USD'])
        expect(cache.bytes).toBe(itemBytes)
    })

    test('an honest peer on a generous cluster stays far under the budget', () => {
        //four keys of 100 assets with six exchanges each, every minute of a 2-hour heartbeat
        const {assetsMap, trades: rows} = honestItem(100, 6)
        const trades = new Trades()
        for (let k = 0; k < 4; k++)
            for (let m = 0; m < 120; m++)
                trades.push(peer, `exchanges_H${k}`, assetsMap, (1000 + m) * minute, rows)

        const cache = trades.__trades.get(peer)
        expect([...cache.getAll().values()].reduce((count, keyData) => count + keyData.size, 0)).toBe(480)
        expect(cache.bytes).toBe(480 * estimateItemBytes(assetsMap, rows))
        expect(cache.bytes).toBe(56_945_280)
        expect(cache.bytes / maxPeerCacheBytes).toBeLessThan(0.6)
    })
})

describe('TradesManager lifecycle', () => {
    test('the cleanup timer never keeps the process alive on its own', () => {
        jest.useRealTimers()
        const tm = new TradesManager()
        try {
            expect(tm.__cleanupTimeout.hasRef()).toBe(false)
        } finally {
            tm.stop()
        }
    })

    test('stop() clears the cleanup timer and releases every open sync entry', () => {
        const now = 100_000 * minute
        jest.useFakeTimers({now})
        const tm = new TradesManager()
        const item = tm.__getOrAddTimestampSync('exchanges_USD', now - minute)
        expect(jest.getTimerCount()).toBe(2) //the cleanup worker and the entry deadline

        tm.stop()

        expect(jest.getTimerCount()).toBe(0)
        expect(item.isProcessed).toBe(true)
        expect(tm.__timestamps.size).toBe(0)
        //nothing re-arms after the stop
        jest.advanceTimersByTime(5 * minute)
        expect(jest.getTimerCount()).toBe(0)
    })
})
