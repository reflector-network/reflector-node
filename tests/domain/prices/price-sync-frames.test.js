/*eslint-disable no-undef */
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({
    broadcast: jest.fn(() => Promise.resolve()),
    sendTo: jest.fn(() => Promise.resolve()),
    getConnectedNodes: jest.fn(() => [])
}))

const {ContractTypes, Asset} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const dataSourcesManager = require('../../../src/domain/data-sources-manager')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const nodesManager = require('../../../src/domain/nodes/nodes-manager')
const constants = require('../../../src/ws-server/contstants')
const MessageTypes = require('../../../src/ws-server/handlers/message-types')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const logger = require('../../../src/logger')

const {__getPriceSyncMessages: getPriceSyncMessages} = TradesManager
const minute = 60 * 1000
const T = 1_800_000_000_000
const frameBudget = 512 * 1024
//ChannelBase.send stamps a uuid requestId onto every message it sends, so that is what reaches the peer
const requestId = '9b2d5a9e-6c1f-4f7e-8a51-3f0d2c7b1e44'

/**
 * @param {object} message - a PRICE_SYNC message
 * @returns {number} bytes of the frame the peer receives for it
 */
function wireBytes(message) {
    return Buffer.byteLength(JSON.stringify({...message, requestId}))
}

/**
 * @param {number} [assetCount] - assets in the map
 * @returns {object} one minute of exchanges_USD as TradesDataItem.toPlainObject gives it: 20 assets priced by 5 exchanges
 */
function plainItem(assetCount = 20) {
    const codes = Array.from({length: assetCount}, (_, i) => `ASSET${i}`)
    const sources = ['binance', 'bybit', 'coinbase', 'kraken', 'okx']
    return {
        assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: codes.map(code => ({type: 2, code}))},
        trades: codes.map(() => sources.map(source => ({volume: '1234567890123456789', quoteVolume: '98765432109876543210987', source})))
    }
}

/**
 * @param {number} minutes - minutes of one key; the default 2 h heartbeat window holds 121
 * @param {function(number): object} [itemAt] - the plain item of the minute i minutes before T
 * @returns {Map<string, Map<number, {toPlainObject: function(): object}>>} trades data as TradesCache.getAll gives it
 */
function cacheOf(minutes, itemAt = () => plainItem()) {
    const timestamps = new Map()
    for (let i = 0; i < minutes; i++)
        timestamps.set(T - i * minute, {toPlainObject: () => itemAt(i)})
    return new Map([['exchanges_USD', timestamps]])
}

/**
 * @param {Array<{data: object}>} messages - PRICE_SYNC frames
 * @returns {object} every frame's data merged, key by key and minute by minute
 */
function merged(messages) {
    const data = {}
    for (const {data: frame} of messages)
        for (const [key, minutes] of Object.entries(frame))
            for (const [ts, item] of Object.entries(minutes)) {
                if (!data[key])
                    data[key] = {}
                expect(data[key][ts]).toBeUndefined() //every item travels once
                data[key][ts] = item
            }
    return data
}

describe('PRICE_SYNC frames stay under the peer frame cap', () => {
    test('a reconnect backfill of one key at the default heartbeat is larger than the cap as one frame', () => {
        const data = {exchanges_USD: {}}
        for (const [ts, item] of cacheOf(121).get('exchanges_USD'))
            data.exchanges_USD[ts] = item.toPlainObject()
        expect(Buffer.byteLength(JSON.stringify({type: MessageTypes.PRICE_SYNC, data}))).toBe(1_183_538)
        expect(Buffer.byteLength(JSON.stringify({type: MessageTypes.PRICE_SYNC, data}))).toBeGreaterThan(constants.maxPayload)
    })

    test('it is cut into frames of at most half the cap that together carry every minute once', () => {
        const messages = getPriceSyncMessages(cacheOf(121))
        expect(messages).toHaveLength(3)
        const minutes = []
        for (const message of messages) {
            expect(message.type).toBe(MessageTypes.PRICE_SYNC)
            expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(frameBudget)
            expect(wireBytes(message)).toBeLessThanOrEqual(frameBudget)
            minutes.push(...Object.keys(message.data.exchanges_USD).map(Number))
        }
        expect(minutes.sort((a, b) => a - b)).toEqual([...cacheOf(121).get('exchanges_USD').keys()].sort((a, b) => a - b))
    })

    test('a small payload stays one frame', () => {
        const messages = getPriceSyncMessages(cacheOf(3))
        expect(messages).toHaveLength(1)
        expect(Object.keys(messages[0].data.exchanges_USD).map(Number)).toEqual([T, T - minute, T - 2 * minute])
    })

    test('an empty cache or an empty key sends nothing', () => {
        expect(getPriceSyncMessages(new Map())).toEqual([])
        expect(getPriceSyncMessages(new Map([['exchanges_USD', new Map()]]))).toEqual([])
    })

    //a receiver merges frame by frame, so the frames must carry exactly the items one message carried, each one whole:
    //an item is never split across frames, so no frame a peer receives presents part of a minute
    test('the frames reassemble into exactly the single message, item for item, and are cut the same way every time', () => {
        const itemAt = i => plainItem(10 + (i % 7)) //items of different sizes, so the cut falls unevenly
        const single = {}
        for (const [key, minutes] of cacheOf(121, itemAt)) {
            single[key] = {}
            for (const [ts, item] of minutes)
                single[key][ts] = item.toPlainObject()
        }
        const messages = getPriceSyncMessages(cacheOf(121, itemAt))

        expect(messages.length).toBeGreaterThan(1)
        expect(merged(messages)).toEqual(single)
        expect(JSON.stringify(getPriceSyncMessages(cacheOf(121, itemAt)))).toBe(JSON.stringify(messages))
    })

    test('keys go out in sorted order, each key\'s minutes in cache order', () => {
        const tradesData = new Map([
            ['pubnet_USDC', new Map([[T, {toPlainObject: () => plainItem(1)}]])],
            ['exchanges_USD', new Map([[T - minute, {toPlainObject: () => plainItem(1)}], [T, {toPlainObject: () => plainItem(1)}]])]
        ])
        const [message] = getPriceSyncMessages(tradesData)
        expect(Object.keys(message.data)).toEqual(['exchanges_USD', 'pubnet_USDC'])
        expect(Object.keys(message.data.exchanges_USD)).toEqual([String(T - minute), String(T)])
    })

    //the validator leaves the number of assets open and relies on the 1 MiB frame to bound an item, so an item larger
    //than half the cap that still fits the cap goes out alone, as it did before; only an item no peer would accept is
    //kept back, and it does not hold back the others
    test('an item above half the cap goes alone in its frame; an item above the cap is not sent and blocks nothing', () => {
        logger.warn.mockClear()
        const big = plainItem(1500)
        const huge = plainItem(2500)
        expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(frameBudget)
        expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(constants.maxPayload)
        expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(constants.maxPayload)
        const sizes = [big, plainItem(), big, huge, plainItem()]

        const messages = getPriceSyncMessages(cacheOf(5, i => sizes[i]))

        expect(messages.map(({data}) => Object.keys(data.exchanges_USD).map(ts => (T - Number(ts)) / minute))).toEqual([[0], [1], [2], [4]])
        for (const message of messages)
            expect(wireBytes(message)).toBeLessThanOrEqual(constants.maxPayload)
        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Price sync item is larger than a frame and is not sent',
            key: 'exchanges_USD',
            timestamp: T - 3 * minute
        }))
    })

    test('the requestId the channel adds is budgeted, so a frame filled to the budget still fits it on the wire', () => {
        const fragment = (ts, item) => Buffer.byteLength(JSON.stringify({exchanges_USD: {[ts]: item}}))
        const envelope = Buffer.byteLength(JSON.stringify({type: MessageTypes.PRICE_SYNC, data: {}}))
        const first = plainItem()
        //a second item that fills a frame to the budget exactly when the envelope is counted but the requestId is not
        const filler = plainItem(1)
        filler.assetsMap.assets[0].code += 'x'.repeat(frameBudget - envelope - fragment(T, first) - fragment(T - minute, filler))
        expect(envelope + fragment(T, first) + fragment(T - minute, filler)).toBe(frameBudget)

        const messages = getPriceSyncMessages(cacheOf(2, i => (i === 0 ? first : filler)))

        expect(messages).toHaveLength(2)
        for (const message of messages)
            expect(wireBytes(message)).toBeLessThanOrEqual(frameBudget)
    })

    //the budget is "at most" maxPriceSyncFrameBytes: a frame whose charged size lands exactly on it is full, not over, so
    //the item that fills it stays in it. The flush is therefore `>`; `>=` would cut one item early for nothing
    test('an item that fills a frame exactly to the budget stays in it; one byte more starts a new frame', () => {
        const fragment = (ts, item) => Buffer.byteLength(JSON.stringify({exchanges_USD: {[ts]: item}}))
        //the charged frame: the envelope with the channel's requestId, as the cutter counts it
        const overhead = Buffer.byteLength(JSON.stringify({type: MessageTypes.PRICE_SYNC, data: {}, requestId}))
        const first = plainItem()
        const filler = plainItem(1)
        filler.assetsMap.assets[0].code += 'x'.repeat(frameBudget - overhead - fragment(T, first) - fragment(T - minute, filler))
        expect(overhead + fragment(T, first) + fragment(T - minute, filler)).toBe(frameBudget)

        const exact = getPriceSyncMessages(cacheOf(2, i => (i === 0 ? first : filler)))
        expect(exact).toHaveLength(1)
        expect(Object.keys(exact[0].data.exchanges_USD).map(Number)).toEqual([T, T - minute])
        expect(wireBytes(exact[0])).toBeLessThanOrEqual(frameBudget)

        filler.assetsMap.assets[0].code += 'x'
        const over = getPriceSyncMessages(cacheOf(2, i => (i === 0 ? first : filler)))
        expect(over.map(({data}) => Object.keys(data.exchanges_USD).map(Number))).toEqual([[T], [T - minute]])
    })

    test('sendTradesData sends every frame to the reconnecting peer', () => {
        const tm = new TradesManager()
        try {
            nodesManager.sendTo.mockClear()
            tm.__trades = {getAll: () => cacheOf(121)}
            tm.sendTradesData('peer-A')
            expect(nodesManager.sendTo).toHaveBeenCalledTimes(getPriceSyncMessages(cacheOf(121)).length)
            expect(nodesManager.sendTo).toHaveBeenCalledTimes(3)
            for (const [pubkey, message] of nodesManager.sendTo.mock.calls) {
                expect(pubkey).toBe('peer-A')
                expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(frameBudget)
            }
            expect(merged(nodesManager.sendTo.mock.calls.map(([, message]) => message))).toEqual(merged(getPriceSyncMessages(cacheOf(121))))
        } finally {
            tm.stop()
        }
    })

    test('a node with no trades yet sends nothing instead of throwing', () => {
        const tm = new TradesManager()
        try {
            nodesManager.sendTo.mockClear()
            tm.__trades = {getAll: () => undefined}
            expect(() => tm.sendTradesData('peer-A')).not.toThrow()
            expect(nodesManager.sendTo).not.toHaveBeenCalled()
        } finally {
            tm.stop()
        }
    })
})

describe('a receiver merges PRICE_SYNC frames as it merged the single message', () => {
    const self = 'self-node'
    const peer = 'peer-1'
    const key = 'exchanges_USD'
    let nowSpy

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T + 30_000)
        container.settingsManager = {
            appConfig: {publicKey: self, dbSyncDelay: 0},
            config: {
                nodes: new Map([[self, {pubkey: self}], [peer, {pubkey: peer}]]),
                contracts: new Map([['oracle', {contractId: 'oracle', type: ContractTypes.ORACLE, dataSource: 'exchanges', baseAsset: new Asset(2, 'USD')}]])
            },
            nodes: new Map([[self, {pubkey: self}], [peer, {pubkey: peer}]]),
            getAssets: () => [],
            getPriceHeartbeat: () => 2 * 60 * 60 * 1000
        }
    })

    afterEach(() => {
        nowSpy.mockRestore()
    })

    /**
     * @param {Array<{data: object}>} messages - PRICE_SYNC messages as the peer sent them
     * @returns {TradesManager} a receiver that merged them in order, each through JSON as the ws layer carries it
     */
    function receive(messages) {
        const tm = new TradesManager()
        tm.setNodes([self, peer])
        for (const message of messages)
            tm.addSyncData(peer, JSON.parse(JSON.stringify(message)).data)
        return tm
    }

    /**
     * @param {TradesManager} tm - receiver
     * @param {number[]} minutes - timestamps to read
     * @returns {Array<{ts: number, held: boolean, presented: boolean, data: any}>} what the receiver holds from the peer
     */
    function heldFromPeer(tm, minutes) {
        const peerCache = tm.__trades.__trades.get(peer)
        return minutes.map(ts => ({
            ts,
            held: tm.__trades.hasData(peer, key, ts),
            presented: !!tm.__timestamps.get(ts)?.get(key)?.__presentedPubkeys.has(peer),
            data: peerCache?.getAll().get(key)?.get(ts)
        }))
    }

    test('all frames leave the same peer data and the same presentations as the single message did', () => {
        const itemAt = i => plainItem(10 + (i % 7))
        const minutes = [...cacheOf(121).get(key).keys()]
        const single = {type: MessageTypes.PRICE_SYNC, data: {[key]: {}}}
        for (const [ts, item] of cacheOf(121, itemAt).get(key))
            single.data[key][ts] = item.toPlainObject()
        const frames = getPriceSyncMessages(cacheOf(121, itemAt))
        expect(frames.length).toBeGreaterThan(1)

        const fromSingle = receive([single])
        const fromFrames = receive(frames)
        try {
            const expected = heldFromPeer(fromSingle, minutes)
            //a peer's cache keeps floor(2 h / 1 min) = 120 minutes of a key, and the peer presented each of them
            expect(expected.filter(({held, presented}) => held && presented)).toHaveLength(120)
            expect(heldFromPeer(fromFrames, minutes)).toEqual(expected)
        } finally {
            fromSingle.stop()
            fromFrames.stop()
        }
    })

    test('a peer that delivered only its first frame has presented exactly the minutes in it, each one whole', () => {
        const frames = getPriceSyncMessages(cacheOf(121))
        const firstFrameMinutes = Object.keys(frames[0].data[key]).map(Number)
        const minutes = [...cacheOf(121).get(key).keys()]

        const partial = receive(frames.slice(0, 1))
        const whole = receive(frames)
        try {
            const held = heldFromPeer(partial, minutes)
            expect(held.filter(({presented}) => presented).map(({ts}) => ts)).toEqual(firstFrameMinutes)
            expect(held.filter(({held: has}) => has).map(({ts}) => ts)).toEqual(firstFrameMinutes)
            const wholeHeld = heldFromPeer(whole, firstFrameMinutes)
            expect(heldFromPeer(partial, firstFrameMinutes)).toEqual(wholeHeld)
        } finally {
            partial.stop()
            whole.stop()
        }
    })
})

describe('the per-tick broadcast goes out in frames too', () => {
    const self = 'self-node'
    const usd = new Asset(2, 'USD')
    let nowSpy
    let dataSource
    let originalInstance

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T + 24_000)
        container.settingsManager = {
            appConfig: {publicKey: self, dbSyncDelay: 0},
            config: {
                nodes: new Map([[self, {pubkey: self}]]),
                contracts: new Map([['oracle', {contractId: 'oracle', type: ContractTypes.ORACLE, dataSource: 'exchanges', baseAsset: usd}]])
            },
            nodes: new Map([[self, {pubkey: self}]]),
            getAssets: () => [],
            getPriceHeartbeat: () => 2 * 60 * 60 * 1000,
            getSimSource: () => undefined
        }
        dataSource = dataSourcesManager.get('exchanges')
        originalInstance = dataSource.instance
        nodesManager.broadcast.mockClear()
    })

    afterEach(() => {
        nowSpy.mockRestore()
        dataSource.instance = originalInstance
    })

    test('a fresh cache of a large map broadcasts every minute it loaded, in frames under half the cap', async () => {
        const assets = Array.from({length: 300}, (_, i) => new Asset(2, `ASSET${i}`))
        const sources = ['binance', 'bybit', 'coinbase', 'kraken', 'okx']
        const row = assets.map(() => sources.map(source => ({volume: 1234567890123456789n, quoteVolume: 98765432109876543210987n, source})))
        let requested = 0
        dataSource.instance = {
            getPriceData: ({count}) => {
                requested = count
                return Promise.resolve(Array.from({length: count}, () => row))
            }
        }
        const tm = new TradesManager()
        try {
            await tm.loadTradesDataForSource(new AssetsMap('exchanges', usd, assets))

            const messages = nodesManager.broadcast.mock.calls.map(([message]) => message)
            expect(requested).toBe(15)
            expect(messages.length).toBeGreaterThan(1)
            for (const message of messages)
                expect(wireBytes(message)).toBeLessThanOrEqual(frameBudget)
            expect(Object.keys(merged(messages).exchanges_USD)).toHaveLength(15)
        } finally {
            tm.stop()
        }
    })
})
