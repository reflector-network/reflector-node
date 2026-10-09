/*eslint-disable no-undef */
//Restarted vs long-running node over one shared mock chain: the heartbeat decision and the reference must both come
//from what the chain returns this tick, so uptime never changes the payload. Adapted from the history-window review.
const chain = {entries: {}}

jest.mock('@reflector/reflector-shared', () => {
    const actual = jest.requireActual('@reflector/reflector-shared')
    return {
        ...actual,
        //a plain function returning a promise: returns only the requested keys the chain still holds
        getContractEntries: jest.fn((contractId, rpc, keys) => {
            const out = {}
            for (const {key} of keys)
                if (chain.entries[key])
                    out[key] = chain.entries[key]
            return Promise.resolve(out)
        })
    }
})

const {ContractTypes} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const logger = require('../../../src/logger')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const TF = 5 * 60 * 1000
const HB = 2 * 60 * 60 * 1000
const B = 1000 * HB //a heartbeat boundary
const ASSETS = [{code: 'A', threshold: 10}, {code: 'B', threshold: 10}]
//asset A moved 1 ppb (below its 10 permille threshold), asset B moved 50% (above it)
const CURRENT = [1_000_000_001n, 3_000_000_000n]
const ON_CHAIN = [1_000_000_000n, 2_000_000_000n]

/**
 * @param {bigint[]} prices - prices of assets 0..n-1, all present
 * @returns {{mask: Buffer, prices: bigint[]}} the update as the contract stores it
 */
function stored(prices) {
    const mask = Buffer.alloc(32, 0)
    for (let i = 0; i < prices.length; i++)
        mask[Math.floor(i / 8)] |= 1 << (i % 8)
    return {mask, prices}
}

/**
 * Runs one tick of __getPricesToUpdate and reports the heartbeat decision the runner itself logged for it.
 * @param {OracleRunner} runner - the node under test
 * @param {number} ts - tick timestamp
 * @returns {Promise<{payload: bigint[], isHeartbeatUpdate: boolean}>}
 */
async function tick(runner, ts) {
    logger.trace.mockClear()
    const payload = await runner.__getPricesToUpdate([...CURRENT], ts, HB, TF, ASSETS)
    const [{isHeartbeatUpdate}] = logger.trace.mock.calls.map(([entry]) => entry).filter(entry => entry.msg === 'Checking price updates')
    return {payload, isHeartbeatUpdate}
}

let original
beforeEach(() => {
    chain.entries = {}
    original = container.settingsManager
    container.settingsManager = {getBlockchainConnectorSettings: () => ({sorobanRpc: ['rpc']})}
})
afterEach(() => {
    container.settingsManager = original
})

describe('restarted vs long-running node', () => {
    test('uniform TTL expiry: the newest entry and everything older are gone -> same decision, same payload', async () => {
        const E = B + TF
        chain.entries = {[B - TF]: stored(ON_CHAIN), [E]: stored(ON_CHAIN)}
        const longRunning = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await longRunning.__loadPriceUpdateHistory(B + 2 * TF, TF, HB)

        //uniform retention: when E expires, the older entry has expired too
        chain.entries = {}
        const T2 = B + 5 * TF
        const restarted = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        const long = await tick(longRunning, T2)
        const fresh = await tick(restarted, T2)

        expect(long).toEqual({payload: CURRENT, isHeartbeatUpdate: true})
        expect(fresh).toEqual({payload: CURRENT, isHeartbeatUpdate: true})
    })

    test('non-monotonic retention (period lowered between L and E): one payload, whatever the uptime', async () => {
        const L = B - TF //before the boundary, long TTL
        const E = B + TF //after the boundary, short TTL (written after a period decrease)
        chain.entries = {[L]: stored(ON_CHAIN), [E]: stored(ON_CHAIN)}
        const longRunning = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await longRunning.__loadPriceUpdateHistory(B + 2 * TF, TF, HB)

        chain.entries = {[L]: stored(ON_CHAIN)} //E expired, L still live
        const T2 = B + 5 * TF
        const restarted = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        const long = await tick(longRunning, T2)
        const fresh = await tick(restarted, T2)

        //both see only L, older than the boundary: both take the heartbeat branch and sign the same payload
        expect(long).toEqual({payload: [1_000_000_001n, 3_000_000_000n], isHeartbeatUpdate: true})
        expect(fresh).toEqual({payload: [1_000_000_001n, 3_000_000_000n], isHeartbeatUpdate: true})
    })

    test('steady state: both nodes see the same chain -> identical decision and payload', async () => {
        const longRunning = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        for (let k = 1; k <= 30; k++) {
            chain.entries[B - 20 * TF + k * TF] = stored(ON_CHAIN)
            await longRunning.__loadPriceUpdateHistory(B - 20 * TF + (k + 1) * TF, TF, HB)
        }
        const T2 = B + 12 * TF
        const restarted = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        const long = await tick(longRunning, T2)
        const fresh = await tick(restarted, T2)

        expect(long).toEqual({payload: [0n, 3_000_000_000n], isHeartbeatUpdate: false})
        expect(fresh).toEqual({payload: [0n, 3_000_000_000n], isHeartbeatUpdate: false})
    })
})

describe('partial two-chunk load', () => {
    test('chunk 1 succeeds, chunk 2 rejects -> abstain, reference not taken from chunk 1', async () => {
        const {getContractEntries} = require('@reflector/reflector-shared')
        getContractEntries.mockClear()
        const T = B + 3 * TF
        chain.entries = {[T - TF]: stored(ON_CHAIN)}
        getContractEntries.mockImplementationOnce(() => Promise.resolve({[T - TF]: chain.entries[T - TF]}))
        getContractEntries.mockImplementationOnce(() => Promise.reject(new Error('chunk 2 down')))
        const node = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)

        //a 14-day heartbeat clamps to 255 timeframes: two batches
        await expect(node.__getPricesToUpdate([...CURRENT], T, 7 * 24 * HB, TF, ASSETS)).rejects.toThrow('Price history load failed')

        expect(getContractEntries).toHaveBeenCalledTimes(2)
        expect(node.__lastLoadedEntries.size).toBe(0)
        expect(node.__getLastOnChainPrices(2)).toEqual([null, null])
    })
})

describe('batch shapes', () => {
    test.each([
        [1, [1]], [199, [199]], [200, [200]], [201, [200, 1]], [254, [200, 54]], [255, [200, 55]], [256, [200, 55]], [24.5, [25]]
    ])('heartbeat = %s timeframes -> batches %j', async (k, shape) => {
        const {getContractEntries} = require('@reflector/reflector-shared')
        getContractEntries.mockClear()
        const node = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        await node.__loadPriceUpdateHistory(B, TF, k * TF)
        const calls = getContractEntries.mock.calls.map(c => c[2])
        expect(calls.map(c => c.length)).toEqual(shape)
        const flat = calls.flat().map(x => x.key)
        expect(new Set(flat).size).toBe(flat.length)
        expect(flat[0]).toBe(B - TF)
        expect(flat[flat.length - 1]).toBe(B - flat.length * TF)
    })
})
