/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const {Asset, ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const Trades = require('../../../src/domain/prices/trades-cache')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')
const logger = require('../../../src/logger')

stopTradesManagersAfterEach(TradesManager)

const minute = 60 * 1000
const now = 100 * minute
const timestamp = 99 * minute
const key = 'exchanges_USD'
const peer = 'peer-1'
const self = 'self-node'

const assets = [new Asset(2, 'BTC'), new Asset(2, 'ETH')]
const assetsMap = new AssetsMap('exchanges', new Asset(2, 'USD'), assets)

let nowSpy

beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
    container.settingsManager = {
        appConfig: {publicKey: self},
        //one oracle on exchanges/USD makes it a key this node reads, so peers register on arrival
        config: {
            nodes: new Map([[self, {pubkey: self}], [peer, {pubkey: peer}]]),
            contracts: new Map([['oracle', {contractId: 'oracle', type: ContractTypes.ORACLE, dataSource: 'exchanges', baseAsset: new Asset(2, 'USD')}]])
        },
        nodes: new Map([[self, {pubkey: self}], [peer, {pubkey: peer}]]),
        getAssets: () => [],
        getPriceHeartbeat: () => 2 * 60 * 60 * 1000
    }
})

//the fixture lists its key as a contract, so addSyncData builds the key list the way production does and the
//list's error branch never runs here
beforeEach(() => {
    logger.error.mockClear()
})

afterEach(() => {
    expect(logger.error.mock.calls.filter(call => call[0]?.msg === 'Failed to build the local cache keys')).toHaveLength(0)
})


afterEach(() => {
    nowSpy.mockRestore()
})

/**
 * @param {object} [overrides] - fields merged over a well-formed item
 * @returns {object} a raw cache item as a peer serialises it
 */
function item(overrides = {}) {
    return {
        assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: [{type: 2, code: 'BTC'}, {type: 2, code: 'ETH'}]},
        trades: [
            [{volume: '100', quoteVolume: '200', source: 'binance'}],
            [{volume: '300', quoteVolume: '400'}] //the Stellar connector emits rows without a source
        ],
        ...overrides
    }
}

/**
 * Serialises one minute of a sender's local data the way the node gossips it: the cache item's toPlainObject(), then
 * JSON, as the ws layer sends it and the receiver parses it
 * @param {AssetsMap} map - the sender's assets map
 * @param {Array} row - what the connector returned for that minute, indexed by asset
 * @returns {object} the item as the receiving node sees it
 */
function gossiped(map, row) {
    const cacheItem = new Trades().push('sender', `${map.source}_${map.baseAsset.code}`, map, timestamp, row)
    return JSON.parse(JSON.stringify(cacheItem.toPlainObject()))
}

/**
 * @param {object} payload - the PRICE_SYNC data field
 * @returns {TradesManager} a manager the payload was fed into
 */
function feed(payload) {
    const tm = new TradesManager()
    container.tradesManager = tm
    tm.addSyncData(peer, payload)
    return tm
}

describe('addSyncData validation', () => {
    test('a well-formed item is cached and reads back', async () => {
        const tm = feed({[key]: {[timestamp]: item()}})

        const data = await tm.getTradesData('exchanges', assetsMap.baseAsset, assets, timestamp)

        expect(data.get(peer)).toEqual([
            [{volume: 100n, quoteVolume: 200n, source: 'binance'}],
            [{volume: 300n, quoteVolume: 400n}]
        ])
    })

    test('an asset code the shared Asset model accepts is not rejected by the validator', () => {
        //a hyphenated generic code and a Stellar CODE:ISSUER code are both legal governance-configured values; a
        //narrower pattern here would take the whole cluster's oracle down on the day one of them is configured
        const issuer = Keypair.random().publicKey()
        const oddAssets = [new Asset(2, 'WRAPPED-BTC'), new Asset(1, `USDC:${issuer}`)]
        const oddMap = new AssetsMap('pubnet_1', new Asset(2, 'BASE_X'), oddAssets)
        const payload = {
            'pubnet_1_BASE_X': {
                [timestamp]: {
                    assetsMap: {
                        source: 'pubnet_1',
                        baseAsset: {type: 2, code: 'BASE_X'},
                        assets: [{type: 2, code: 'WRAPPED-BTC'}, {type: 1, code: `USDC:${issuer}`}]
                    },
                    trades: [
                        [{volume: '1', quoteVolume: '2', source: 'binance'}],
                        [{volume: '3', quoteVolume: '4'}]
                    ]
                }
            }
        }
        const tm = feed(payload)

        const data = tm.__trades.getTradesData('pubnet_1_BASE_X', timestamp, oddAssets)

        expect(data.get(peer)).toEqual([
            [{volume: 1n, quoteVolume: 2n, source: 'binance'}],
            [{volume: 3n, quoteVolume: 4n}]
        ])
        expect(oddMap.getAssetInfo('WRAPPED-BTC').index).toBe(0) //the map the node itself builds carries the same codes
    })

    test('an asset code a subscription ticker can carry is not rejected, whitespace and control characters included', () => {
        //a subscription ticker reaches the map as an AssetType.OTHER Asset bounded only by length, and every honest node
        //gossips its code
        const tickerAssets = [new Asset(2, 'EU R'), new Asset(2, 'A\nB')]
        const honestMap = new AssetsMap('forex', new Asset(2, 'USD'), tickerAssets).toPlainObject()
        const tm = feed({'forex_USD': {[timestamp]: {assetsMap: honestMap, trades: [[{volume: '5', quoteVolume: '6', source: 'ecb'}], []]}}})

        const data = tm.__trades.getTradesData('forex_USD', timestamp, tickerAssets)

        expect(data.get(peer)).toEqual([[{volume: 5n, quoteVolume: 6n, source: 'ecb'}], []])
    })

    test('an asset code longer than the bound is rejected', async () => {
        const bad = item({assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: [{type: 2, code: 'A'.repeat(81)}, {type: 2, code: 'ETH'}]}})
        const tm = feed({[key]: {[timestamp]: bad}})

        const data = await tm.getTradesData('exchanges', assetsMap.baseAsset, assets, timestamp)

        expect(data.get(peer)).toBeFalsy()
    })

    test('an honest row one short of the map is gossiped padded, and the missing trailing asset reads as no data', () => {
        //every provider failed for SOL, the map's last asset: the exchanges connector's pivot never creates SOL's slot,
        //so the row it returns is one entry short. The node pads its own row to the map before it gossips it; a sender
        //before that change sent the row short, and both spellings must read the same
        const withTail = [...assets, new Asset(2, 'SOL')]
        const row = []
        row[0] = [{volume: 100n, quoteVolume: 200n, source: 'binance', completed: true}]
        row[1] = [{volume: 300n, quoteVolume: 400n, source: 'binance', completed: true}]
        const honest = gossiped(new AssetsMap('exchanges', new Asset(2, 'USD'), withTail), row)
        expect(honest.assetsMap.assets).toHaveLength(3)
        expect(honest.trades).toEqual([
            [{volume: '100', quoteVolume: '200', source: 'binance', completed: true}],
            [{volume: '300', quoteVolume: '400', source: 'binance', completed: true}],
            []
        ])
        const legacy = JSON.parse(JSON.stringify({...honest, trades: honest.trades.slice(0, 2)}))

        const read = [honest, legacy]
            .map(sent => feed({[key]: {[timestamp]: sent}}).__trades.getTradesData(key, timestamp, withTail).get(peer))

        for (const peerRead of read)
            expect(peerRead).toEqual([
                [{volume: 100n, quoteVolume: 200n, source: 'binance'}],
                [{volume: 300n, quoteVolume: 400n, source: 'binance'}],
                []
            ])
    })

    test('an honest row with a hole in the middle is gossiped with an empty row there, and the hole reads as no data', () => {
        //every provider failed for SOL, which sits between assets that have data: the exchanges connector's pivot never
        //creates SOL's slot, so the row it returns has a hole there. The node fills the hole with an empty row before it
        //gossips it; a sender before that change sent it as null, and both spellings must read the same
        const withGap = [...assets, new Asset(2, 'SOL'), new Asset(2, 'XRP')]
        const row = []
        row[0] = [{volume: 100n, quoteVolume: 200n, source: 'binance', completed: true}]
        row[1] = [{volume: 300n, quoteVolume: 400n, source: 'binance', completed: true}]
        row[3] = [{volume: 500n, quoteVolume: 600n, source: 'binance', completed: true}]
        const honest = gossiped(new AssetsMap('exchanges', new Asset(2, 'USD'), withGap), row)
        expect(honest.trades).toHaveLength(4)
        expect(honest.trades[2]).toEqual([])
        const legacyText = JSON.stringify(honest).replace(/\],\[\],\[/, '],null,[')
        expect(legacyText).toContain(',null,')
        const legacy = JSON.parse(legacyText)

        const read = [honest, legacy]
            .map(sent => feed({[key]: {[timestamp]: sent}}).__trades.getTradesData(key, timestamp, withGap).get(peer))

        for (const peerRead of read)
            expect(peerRead).toEqual([
                [{volume: 100n, quoteVolume: 200n, source: 'binance'}],
                [{volume: 300n, quoteVolume: 400n, source: 'binance'}],
                [],
                [{volume: 500n, quoteVolume: 600n, source: 'binance'}]
            ])
    })

    /**
     * @param {string} trades - the trades field, as JSON text
     * @param {string} [assetsField] - the assetsMap assets field, as JSON text
     * @returns {Array|undefined} what the node holds for the peer after the item arrived on the wire
     */
    function readTrades(trades, assetsField = '[{"type":2,"code":"BTC"},{"type":2,"code":"ETH"}]') {
        const payload = JSON.parse(`{"${key}":{"${timestamp}":{"assetsMap":{"source":"exchanges","baseAsset":{"type":2,"code":"USD"},`
            + `"assets":${assetsField}},"trades":${trades}}}}`)
        return feed(payload).__trades.getTradesData(key, timestamp, assets).get(peer)
    }

    const btcRow = '[{"volume":"1","quoteVolume":"2","source":"binance"}]'
    const btcRead = [{volume: 1n, quoteVolume: 2n, source: 'binance'}]

    test('null reads as no data wherever it stands in a row', () => {
        expect(readTrades(`[null,${btcRow}]`)).toEqual([[], btcRead])
        expect(readTrades(`[${btcRow},null]`)).toEqual([btcRead, []])
        expect(readTrades('[null,null]')).toEqual([[], []])
        expect(readTrades('[null]')).toEqual([[], []])
    })

    //null is the only spelling of a hole: nothing else a connector returns becomes anything else on the wire
    for (const gap of ['false', 'true', '0', '""', '"x"', '{}', '[null]']) {
        test(`rejects an item whose row holds ${gap} in an asset's place`, () => {
            expect(readTrades(`[${gap},${btcRow}]`)).toBeFalsy()
        })
    }

    test('rejects a row with a hole that is longer than the map', () => {
        expect(readTrades(`[null,${btcRow},null]`)).toBeFalsy()
    })

    test('a row longer than any connector emits is rejected, and one of 32 entries is accepted', () => {
        //a connector puts at most one entry per provider into a row, six at most; a peer's row is copied and scanned
        //on every read of its asset, and a subscription reads its asset every tick
        const row = count => `[${Array.from({length: count}, (_, i) => `{"volume":"1","quoteVolume":"2","source":"s${i}"}`).join(',')}]`

        expect(readTrades(`[${row(32)},[]]`)[0]).toHaveLength(32)
        expect(readTrades(`[${row(33)},[]]`)).toBeFalsy()
    })

    for (const value of ['null', '""', '"x"', '{}', '0']) {
        test(`rejects an item whose trades field is ${value}`, () => {
            expect(readTrades(value)).toBeFalsy()
        })
        test(`rejects an item whose assets field is ${value}`, () => {
            expect(readTrades('[]', value)).toBeFalsy()
        })
    }

    test('a map public subscriptions have grown past any fixed asset count is accepted', () => {
        //getAssetsMap appends both codes of every forex subscription to forex_USD, and valid-symbols.json lets any
        //forex code through, so a thousand subscriptions make an honest map of two thousand and two assets
        const fxMap = new AssetsMap('forex', new Asset(2, 'USD'), [new Asset(2, 'EUR'), new Asset(2, 'GBP')])
        for (let i = 0; i < 1000; i++)
            fxMap.push([new Asset(2, `B${i}`), new Asset(2, `Q${i}`)])
        const row = fxMap.assets.map((a, i) => [{volume: BigInt(1000 + i), quoteVolume: 10n ** 14n, source: 'ecb'}])
        const honest = gossiped(fxMap, row)
        expect(honest.assetsMap.assets).toHaveLength(2002)

        const tm = feed({'forex_USD': {[timestamp]: honest}})

        const read = [new Asset(2, 'EUR'), new Asset(2, 'Q999')]
        expect(tm.__trades.getTradesData('forex_USD', timestamp, read).get(peer)).toEqual([
            [{volume: 1000n, quoteVolume: 10n ** 14n, source: 'ecb'}],
            [{volume: 3001n, quoteVolume: 10n ** 14n, source: 'ecb'}]
        ])
    })

    test('an honest volume past 40 digits, as a pool of a large-supply token yields, is accepted', () => {
        //the Stellar connector restates a constant-product pool's i128 reserve at 14 decimals and uses it as the
        //volume: near the i128 maximum, a 7-decimal token's reserve comes out at 46 digits on every honest node
        const usdc = new Asset(1, 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
        const token = new Asset(1, `BIG:${Keypair.random().publicKey()}`)
        const reserve = (2n ** 127n - 1n) * 10n ** 7n
        expect(reserve.toString()).toHaveLength(46)
        const honest = gossiped(new AssetsMap('pubnet', usdc, [token]), [[{volume: 10n ** 16n, quoteVolume: reserve}]])
        const pubnetKey = `pubnet_${usdc.code}`

        const tm = feed({[pubnetKey]: {[timestamp]: honest}})

        expect(tm.__trades.getTradesData(pubnetKey, timestamp, [token]).get(peer)).toEqual([[{volume: 10n ** 16n, quoteVolume: reserve}]])
    })

    test('a volume of 1000 digits is accepted and one of 1001 is rejected', () => {
        const withVolume = digits => JSON.parse(`{"${key}":{"${timestamp}":{"assetsMap":{"source":"exchanges","baseAsset":{"type":2,"code":"USD"},`
            + `"assets":[{"type":2,"code":"BTC"},{"type":2,"code":"ETH"}]},"trades":[[{"volume":"${'9'.repeat(digits)}","quoteVolume":"2"}],[]]}}}`)

        const longest = feed(withVolume(1000)).__trades.getTradesData(key, timestamp, assets).get(peer)
        expect(longest).toEqual([[{volume: 10n ** 1000n - 1n, quoteVolume: 2n}], []])
        expect(feed(withVolume(1001)).__trades.getTradesData(key, timestamp, assets).get(peer)).toBeFalsy()
    })

    const malformed = {
        'assets is a string': item({assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: 'x'}}),
        //no connector produces a row for an asset the map does not name
        'trades is longer than assets': JSON.parse('{"assetsMap":{"source":"exchanges","baseAsset":{"type":2,"code":"USD"},'
            + '"assets":[{"type":2,"code":"BTC"},{"type":2,"code":"ETH"}]},"trades":[[],[],[{"volume":"1","quoteVolume":"2"}]]}'),
        'trades is not an array': item({trades: 'x'}),
        'a trades row is not an array': item({trades: [{volume: '1'}, []]}),
        'volume is not a decimal string': item({trades: [[{volume: 1, quoteVolume: '2', source: 'b'}], []]}),
        'volume is negative': item({trades: [[{volume: '-1', quoteVolume: '2', source: 'b'}], []]}),
        'source is not a string': item({trades: [[{volume: '1', quoteVolume: '2', source: 7}], []]}),
        'an asset has no code': item({assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: [{type: 2}, {type: 2, code: 'ETH'}]}}),
        'asset codes repeat': item({assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: [{type: 2, code: 'BTC'}, {type: 2, code: 'BTC'}]}}),
        'the source does not match the key': item({assetsMap: {source: 'forex', baseAsset: {type: 2, code: 'USD'}, assets: [{type: 2, code: 'BTC'}, {type: 2, code: 'ETH'}]}}),
        'the base asset does not match the key': item({assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'EUR'}, assets: [{type: 2, code: 'BTC'}, {type: 2, code: 'ETH'}]}}),
        'assetsMap is missing': {trades: []},
        'the item is a string': 'poison'
    }

    for (const [name, payload] of Object.entries(malformed)) {
        test(`rejects an item where ${name} and reading it yields no data for that peer`, async () => {
            const tm = feed({[key]: {[timestamp]: payload}})

            const data = await tm.getTradesData('exchanges', assetsMap.baseAsset, assets, timestamp)

            expect(data.get(peer)).toBeFalsy()
        })
    }

    test('rejects a timestamp that is not minute-aligned', () => {
        const tm = feed({[key]: {[timestamp + 1]: item()}})
        //read the slot the item would be filed under: a read at the aligned minute never finds it, rejected or not
        expect(tm.__trades.getTradesData(key, timestamp + 1, assets).get(peer)).toBeFalsy()
    })

    test('rejects a timestamp further ahead than one minute', () => {
        const future = now + 2 * minute //the first aligned minute past the bound; the window's span sets the per-key cap
        const tm = feed({[key]: {[future]: item()}})
        expect(tm.__trades.getTradesData(key, future, assets).get(peer)).toBeFalsy()
    })

    test('rejects a timestamp older than the heartbeat window', () => {
        const ancient = now - 2 * 60 * 60 * 1000 - 2 * minute //the first aligned minute past the two-hour bound
        const tm = feed({[key]: {[ancient]: item()}})
        expect(tm.__trades.getTradesData(key, ancient, assets).get(peer)).toBeFalsy()
    })

    test('rejects a key that does not describe its own payload', () => {
        const tm = feed({'exchanges_USD_extra': {[timestamp]: item()}})
        expect(tm.__trades.getTradesData('exchanges_USD_extra', timestamp, assets).get(peer)).toBeFalsy()
    })

    test('a payload that is not an object is ignored without throwing', () => {
        expect(() => feed('nope')).not.toThrow()
        expect(() => feed(null)).not.toThrow()
    })

    test('drops a message that carries more keys than the cap', () => {
        const payload = {}
        for (let i = 0; i < 70; i++) {
            payload[`exchanges_C${i}`] = {
                [timestamp]: {
                    assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: `C${i}`}, assets: [{type: 2, code: 'BTC'}]},
                    trades: [[{volume: '1', quoteVolume: '2', source: 'binance'}]]
                }
            }
        }
        const tm = feed(payload)

        //the whole message is dropped, so not even the first key was cached
        expect(tm.__trades.getTradesData('exchanges_C0', timestamp, [assets[0]]).get(peer)).toBeFalsy()
    })

})

describe('timestamps per key are bounded by the heartbeat', () => {
    const later = 10000 * minute //clear of zero, so even a five-hour window holds only positive minutes
    const expected = [[{volume: 1n, quoteVolume: 2n, source: 'binance'}], []]
    const expectedItem = [[{volume: 100n, quoteVolume: 200n, source: 'binance'}], [{volume: 300n, quoteVolume: 400n}]]

    /**
     * @param {number} minutes - heartbeat the mocked settings report
     */
    function setHeartbeat(minutes) {
        container.settingsManager.getPriceHeartbeat = () => minutes * minute
    }

    /**
     * Builds the backfill a sender gossips on READY: every timestamp its own cache holds for the key after the cache's
     * trim to the current heartbeat, serialised as sendTradesData does and parsed as the receiver parses it
     * @param {number} minutes - consecutive minutes the sender loaded, the newest labelled `later`
     * @returns {object} the PRICE_SYNC data field
     */
    function backfill(minutes) {
        const sender = new Trades()
        for (let i = minutes - 1; i >= 0; i--)
            sender.push(self, key, assetsMap, later - i * minute, [[{volume: 1n, quoteVolume: 2n, source: 'binance'}], []])
        const data = {}
        for (const [k, items] of sender.getAll()) {
            data[k] = {}
            for (const [ts, cacheItem] of items)
                data[k][ts] = cacheItem.toPlainObject()
        }
        return JSON.parse(JSON.stringify(data))
    }

    /**
     * @param {string[]} spellings - property names for the timestamps, as they appear in the message
     * @returns {object} a PRICE_SYNC data field carrying one valid item under each spelling
     */
    function message(spellings) {
        const entry = JSON.stringify(item())
        return JSON.parse(`{"${key}":{${spellings.map(s => `"${s}":${entry}`).join(',')}}}`)
    }

    test('an honest backfill at a heartbeat above 256 minutes is accepted whole', () => {
        nowSpy.mockReturnValue(later + 10 * 1000)
        setHeartbeat(300)
        const data = backfill(300)
        expect(Object.keys(data[key])).toHaveLength(300)

        const tm = feed(data)

        expect(tm.__trades.getTradesData(key, later, assets).get(peer)).toEqual(expected)
        expect(tm.__trades.getTradesData(key, later - 299 * minute, assets).get(peer)).toEqual(expected)
    })

    test('a backfill from a sender still on a longer heartbeat keeps the part inside the window', () => {
        nowSpy.mockReturnValue(later + 10 * 1000)
        setHeartbeat(120) //the sender has not adopted the shorter heartbeat yet, so it still holds 120 minutes
        const data = backfill(120)
        setHeartbeat(30) //the receiver has

        const tm = feed(data)

        expect(tm.__trades.getTradesData(key, later, assets).get(peer)).toEqual(expected)
        expect(tm.__trades.getTradesData(key, later - 29 * minute, assets).get(peer)).toEqual(expected)
        expect(tm.__trades.getTradesData(key, later - 31 * minute, assets).get(peer)).toBeFalsy()
    })

    test('every minute the window holds, once each, is accepted', () => {
        nowSpy.mockReturnValue(later) //an aligned clock: the window [now - 121 min, now + 1 min] holds 123 minutes
        const spellings = []
        for (let i = -1; i <= 121; i++)
            spellings.push(String(later - i * minute))
        expect(spellings).toHaveLength(123)

        const tm = feed(message(spellings))

        expect(tm.__trades.getTradesData(key, later + minute, assets).get(peer)).toEqual(expectedItem)
    })

    test('a key carrying more in-window entries than the window has minutes is dropped', () => {
        nowSpy.mockReturnValue(later)
        const spellings = []
        for (let i = -1; i <= 121; i++)
            spellings.push(String(later - i * minute))
        spellings.push(`${later}.0`) //Number() reads it as a minute already present; no honest sender writes it
        const payload = message(spellings)
        expect(Object.keys(payload[key])).toHaveLength(124)

        const tm = feed(payload)

        expect(tm.__trades.getTradesData(key, later + minute, assets).get(peer)).toBeFalsy()
        expect(tm.__trades.getTradesData(key, later, assets).get(peer)).toBeFalsy()
    })
})
