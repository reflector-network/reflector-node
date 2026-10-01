/*eslint-disable no-undef */
jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared'),
    getOracleContractState: jest.fn(),
    getContractEntries: jest.fn(),
    //echoes the payload so a test can read exactly what the node would have signed
    buildOraclePriceUpdateTransaction: jest.fn(options => Promise.resolve({prices: options.prices}))
}))
jest.mock('../../../src/utils', () => ({
    ...jest.requireActual('../../../src/utils'),
    getAccount: jest.fn(() => Promise.resolve({}))
}))
jest.mock('../../../src/domain/prices/price-manager', () => ({
    getPricesForContract: jest.fn()
}))
jest.mock('../../../src/domain/data-sources-manager', () => ({
    setGateways: jest.fn(),
    setDataSources: jest.fn(),
    dispose: jest.fn(),
    get: jest.fn(),
    has: jest.fn(() => true),
    issues: []
}))

const {ContractTypes, getOracleContractState, getContractEntries, buildOraclePriceUpdateTransaction} = require('@reflector/reflector-shared')
const {getPricesForContract} = require('../../../src/domain/prices/price-manager')
const container = require('../../../src/domain/container')
const logger = require('../../../src/logger')
const SettingsManager = require('../../../src/domain/settings-manager')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const TIMEFRAME = 5 * 60 * 1000
const HEARTBEAT = 2 * 60 * 60 * 1000
//three timeframes past a heartbeat boundary: the last on-chain entry is past the boundary, so this is a threshold tick
const TICK = 1000 * HEARTBEAT + 3 * TIMEFRAME
const ON_CHAIN = [1_000_000_000n, 2_000_000_000n]
//asset 0 moved 1 ppb (below its 10 permille threshold), asset 1 moved 50% (above it)
const CURRENT = [1_000_000_001n, 3_000_000_000n]

/**
 * @param {bigint[]} prices - prices of assets 0..n-1, all present
 * @returns {{mask: Buffer, prices: bigint[]}} the update as the contract stores it
 */
function storedUpdate(prices) {
    const mask = Buffer.alloc(32, 0)
    for (let i = 0; i < prices.length; i++)
        mask[Math.floor(i / 8)] |= 1 << (i % 8)
    return {mask, prices}
}

/**
 * An honest node: same config, same contract state, same fetched prices; only its history load differs.
 * @param {Array<[number, bigint[]]>} [cache] - entries an earlier tick of this process loaded
 * @returns {OracleRunner}
 */
function makeNode(cache = []) {
    const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
    runner.__isTxExpired = () => false
    runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve())
    for (const [ts, prices] of cache)
        runner.__lastLoadedEntries.set(ts, prices)
    return runner
}

/**
 * @param {OracleRunner} runner - a node that has run __workerFn for the tick
 * @returns {Promise<bigint[]|null>} the prices this node would sign for the tick, or null when it builds nothing
 */
async function signedPayload(runner) {
    const {calls} = runner.__buildAndSubmitTransaction.mock
    if (!calls.length)
        return null
    const [buildTxFn] = calls[0]
    return (await buildTxFn({}, 100, 0)).prices
}

describe('a failed history load abstains instead of diverging', () => {
    let originalSettings

    beforeEach(() => {
        originalSettings = container.settingsManager
        const manager = new SettingsManager()
        manager.config = {
            contracts: new Map([[CONTRACT_ID, {
                contractId: CONTRACT_ID,
                type: ContractTypes.ORACLE_BEAM,
                timeframe: TIMEFRAME,
                admin: 'admin',
                fee: 100,
                assets: [{code: 'BTC', threshold: 10}, {code: 'ETH', threshold: 10}]
            }]])
        }
        manager.getBlockchainConnectorSettings = () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['rpc']})
        container.settingsManager = manager
        getOracleContractState.mockResolvedValue({isInitialized: true, lastTimestamp: BigInt(TICK - TIMEFRAME), protocol: 2})
        getPricesForContract.mockImplementation(() => Promise.resolve([...CURRENT]))
        getContractEntries.mockReset()
        getContractEntries.mockImplementation(() => Promise.resolve({[TICK - TIMEFRAME]: storedUpdate(ON_CHAIN)}))
        buildOraclePriceUpdateTransaction.mockClear()
        logger.error.mockClear()
    })

    afterEach(() => {
        container.settingsManager = originalSettings
    })

    test.each([
        ['freshly restarted', []],
        ['long-running', [[TICK - 2 * TIMEFRAME, [...ON_CHAIN]]]]
    ])('a %s node whose load fails signs nothing, while a healthy node signs the thresholded payload', async (label, cache) => {
        const healthy = makeNode()
        expect(await healthy.__workerFn(TICK)).toBe(true)

        const failing = makeNode(cache)
        getContractEntries.mockRejectedValueOnce(new Error('rpc down'))
        await expect(failing.__workerFn(TICK)).rejects.toThrow('Price history load failed; abstaining from this tick')

        //the healthy node zeroes the sub-threshold asset against the on-chain reference
        expect(await signedPayload(healthy)).toEqual([0n, 3_000_000_000n])
        //the failing node builds nothing: no transaction, so no signature to broadcast
        expect(failing.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(await signedPayload(failing)).toBe(null)
        expect(buildOraclePriceUpdateTransaction).toHaveBeenCalledTimes(1)
    })

    test('the worker absorbs the abstention and schedules the next tick', async () => {
        const failing = makeNode()
        failing.isRunning = true
        getContractEntries.mockRejectedValueOnce(new Error('rpc down'))
        try {
            await failing.worker(TICK)
        } finally {
            failing.stop()
        }
        expect(failing.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Error in worker',
            timestamp: TICK,
            err: expect.objectContaining({message: 'Price history load failed; abstaining from this tick'})
        }))
    })

    test('once the rpc is back, the same node signs the healthy payload again', async () => {
        const node = makeNode()
        getContractEntries.mockRejectedValueOnce(new Error('rpc down'))
        await expect(node.__workerFn(TICK)).rejects.toThrow('Price history load failed')

        expect(await node.__workerFn(TICK)).toBe(true)

        expect(await signedPayload(node)).toEqual([0n, 3_000_000_000n])
    })
})
