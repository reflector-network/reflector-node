/*eslint-disable no-undef */
const mockEntries = {calls: [], result: {}}

jest.mock('@reflector/reflector-shared', () => {
    const actual = jest.requireActual('@reflector/reflector-shared')
    return {
        ...actual,
        //a plain function returning a promise: nothing here is awaited, and an async one trips require-await
        getContractEntries: jest.fn((contractId, rpc, keys) => {
            mockEntries.calls.push(keys.map(k => k.key))
            return Promise.resolve(mockEntries.result)
        })
    }
})

const {ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const TIMEFRAME_5M = 5 * 60 * 1000
const HEARTBEAT_2H = 2 * 60 * 60 * 1000
const MAX_PRICES_CACHE_SIZE = 255
const NOW = 10_000_000_000

let originalSettings

beforeEach(() => {
    mockEntries.calls = []
    mockEntries.result = {}
    originalSettings = container.settingsManager
    container.settingsManager = {
        getBlockchainConnectorSettings: () => ({sorobanRpc: ['http://rpc.invalid']})
    }
})

afterEach(() => {
    container.settingsManager = originalSettings
})

describe('__loadPriceUpdateHistory window', () => {
    test('the requested keys stop at the heartbeat bound, not at a hard-coded two hours', async () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, 4 * 60 * 60 * 1000)
        const requested = mockEntries.calls.flat()
        const oldest = Math.min(...requested)
        expect(requested[0]).toBe(NOW - TIMEFRAME_5M)
        expect(oldest).toBeLessThanOrEqual(NOW - 4 * 60 * 60 * 1000)
        expect(oldest).toBeGreaterThan(NOW - 4 * 60 * 60 * 1000 - 2 * TIMEFRAME_5M)
    })

    test('the window is clamped to the cache capacity', async () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, 1000 * 60 * 60 * 24 * 7)
        const requested = mockEntries.calls.flat()
        expect(requested.length).toBeLessThanOrEqual(MAX_PRICES_CACHE_SIZE)
        expect(Math.min(...requested)).toBeGreaterThanOrEqual(NOW - MAX_PRICES_CACHE_SIZE * TIMEFRAME_5M)
    })

    test('a window of exactly one batch is requested in one call, with no empty trailing batch', async () => {
        //an empty trailing batch would reach getLedgerEntries with no keys; if the rpc rejects that, every node
        //with this configuration would fail the load, and so abstain, on every tick
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, 200 * TIMEFRAME_5M)
        expect(mockEntries.calls.map(keys => keys.length)).toEqual([200])
        expect(mockEntries.calls[0][199]).toBe(NOW - 200 * TIMEFRAME_5M)
    })

    test('a window wider than one batch is split into batches of 200', async () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, 1000 * 60 * 60 * 24 * 7)
        expect(mockEntries.calls.map(keys => keys.length)).toEqual([200, 55])
        expect(mockEntries.calls[1][54]).toBe(NOW - MAX_PRICES_CACHE_SIZE * TIMEFRAME_5M)
    })

    test('a restarted node and a long-running node derive the same reference', async () => {
        const restarted = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        const longRunning = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        //the long-running node carries entries the chain has since dropped
        for (let i = 1; i < 60; i++)
            longRunning.__lastLoadedEntries.set(NOW - i * TIMEFRAME_5M, [BigInt(i)])
        //the chain no longer returns the older entries (temporary-entry TTL), and the one it returns does not price asset 0
        mockEntries.result = {[NOW - TIMEFRAME_5M]: {mask: maskFor(1), prices: [7n]}}

        await restarted.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, HEARTBEAT_2H)
        await longRunning.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, HEARTBEAT_2H)

        expect(longRunning.__getLastOnChainPrices(2)).toEqual(restarted.__getLastOnChainPrices(2))
        expect(restarted.__getLastOnChainPrices(2)[0]).toBe(null)
    })

    test('the reference holds only what this tick loaded, not what earlier ticks did', async () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        mockEntries.result = {[NOW - TIMEFRAME_5M]: {mask: maskFor(0), prices: [7n]}}
        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, HEARTBEAT_2H)
        expect(runner.__getLastOnChainPrices(1)).toEqual([{price: 7n, timestamp: NOW - TIMEFRAME_5M}])

        //the chain has since dropped that entry: a node that restarts now would find nothing, and so must this one
        mockEntries.result = {}
        await runner.__loadPriceUpdateHistory(NOW + TIMEFRAME_5M, TIMEFRAME_5M, HEARTBEAT_2H)

        expect(runner.__getLastOnChainPrices(1)).toEqual([null])
    })

    test('an already-cached timestamp does not shorten the request', async () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        runner.__lastLoadedEntries.set(NOW - TIMEFRAME_5M, [1n])
        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, HEARTBEAT_2H)
        expect(mockEntries.calls.flat().length).toBe(HEARTBEAT_2H / TIMEFRAME_5M)
    })

    test('the plain oracle type still returns before the load', async () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
        await runner.__getPricesToUpdate([0n], NOW, HEARTBEAT_2H, TIMEFRAME_5M, [{code: 'BTC'}])
        expect(mockEntries.calls.length).toBe(0)
    })

    test('an rpc failure makes the node abstain instead of signing a different payload', async () => {
        const {getContractEntries} = require('@reflector/reflector-shared')
        getContractEntries.mockRejectedValueOnce(new Error('rpc down'))
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        runner.__lastLoadedEntries.set(NOW - TIMEFRAME_5M, [1n]) //an earlier tick loaded it; a failed load must not keep it

        await expect(runner.__getPricesToUpdate([5n], NOW, HEARTBEAT_2H, TIMEFRAME_5M, [{code: 'BTC'}]))
            .rejects.toThrow('Price history load failed')

        expect(runner.__lastLoadedEntries.size).toBe(0)
        expect(runner.__historyLoadFailed).toBe(true)
    })

    test('the failure does not outlive the tick that recorded it', async () => {
        const {getContractEntries} = require('@reflector/reflector-shared')
        getContractEntries.mockRejectedValueOnce(new Error('rpc down'))
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, HEARTBEAT_2H)
        expect(runner.__historyLoadFailed).toBe(true)

        await runner.__loadPriceUpdateHistory(NOW + TIMEFRAME_5M, TIMEFRAME_5M, HEARTBEAT_2H)

        expect(runner.__historyLoadFailed).toBe(false)
    })
})

describe('__getLastOnChainPrices', () => {
    test('returns the most recent non-zero price and its timestamp per asset', () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
        runner.__lastLoadedEntries.set(NOW - 3 * TIMEFRAME_5M, [100n, 200n, 300n])
        runner.__lastLoadedEntries.set(NOW - 2 * TIMEFRAME_5M, [110n, 0n, 0n])
        runner.__lastLoadedEntries.set(NOW - TIMEFRAME_5M, [120n, 0n, 0n])

        const last = runner.__getLastOnChainPrices(4)

        expect(last[0]).toEqual({price: 120n, timestamp: NOW - TIMEFRAME_5M})
        expect(last[1]).toEqual({price: 200n, timestamp: NOW - 3 * TIMEFRAME_5M})
        expect(last[2]).toEqual({price: 300n, timestamp: NOW - 3 * TIMEFRAME_5M})
        expect(last[3]).toBe(null)
    })

    test('returns nulls for an empty history', () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
        expect(runner.__getLastOnChainPrices(2)).toEqual([null, null])
    })
})

/**
 * @param {number} assetIndex - index of the only asset present in the update
 * @returns {Buffer} the 32-byte presence mask the contract stores next to the prices
 */
function maskFor(assetIndex) {
    const mask = Buffer.alloc(32, 0)
    mask[Math.floor(assetIndex / 8)] |= 1 << (assetIndex % 8)
    return mask
}

describe('price history load deadline', () => {
    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    test('a history load that never answers ends at the budget and the node abstains', async () => {
        const {getContractEntries} = require('@reflector/reflector-shared')
        getContractEntries.mockImplementationOnce(() => new Promise(() => {}))
        jest.useFakeTimers()
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        runner.__lastLoadedEntries.set(NOW - TIMEFRAME_5M, [1n]) //an earlier tick loaded it; a timed-out load must not keep it

        const attempt = runner.__getPricesToUpdate([5n], NOW, HEARTBEAT_2H, TIMEFRAME_5M, [{code: 'BTC'}])
        const assertion = expect(attempt).rejects.toThrow('Price history load failed')
        await jest.advanceTimersByTimeAsync(20_001)
        await assertion

        expect(runner.__historyLoadFailed).toBe(true)
        expect(runner.__lastLoadedEntries.size).toBe(0)
    })
})

describe('no accumulated per-process cache', () => {
    test('the runner keeps only what this tick loaded', async () => {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        mockEntries.result = {[NOW - TIMEFRAME_5M]: {mask: maskFor(0), prices: [7n]}}

        await runner.__loadPriceUpdateHistory(NOW, TIMEFRAME_5M, HEARTBEAT_2H)

        expect(runner.__pricesCache).toBeUndefined()
        expect([...runner.__lastLoadedEntries.keys()]).toEqual([NOW - TIMEFRAME_5M])
    })
})
