/*eslint-disable no-undef, class-methods-use-this, require-await */
const {Keypair} = require('@stellar/stellar-sdk')
const {PendingTransactionBase, PendingTransactionType} = require('@reflector/reflector-shared')

const mockSubmit = jest.fn(async () => {
    throw new Error('refused')
})

jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({
    setLastProcessedTimestamp: jest.fn(),
    incSubmittedTransactions: jest.fn(),
    setProcessedTx: jest.fn()
}))
jest.mock('../../../src/utils', () => ({
    submitTransaction: (...args) => mockSubmit(...args),
    txTimeoutMessage: 'Tx timed out.',
    getAccount: jest.fn(),
    isDebugging: () => false,
    withDeadline: promise => promise
}))

const {Account} = require('@stellar/stellar-sdk')
const container = require('../../../src/domain/container')
const RunnerBase = require('../../../src/domain/runners/runner-base')

const ownKp = Keypair.random()
const contractId = 'C'.repeat(56)

class TestTransaction extends PendingTransactionBase {}

class TestRunner extends RunnerBase {
    constructor(roundLength) {
        super(contractId)
        this.testRoundLength = roundLength
    }

    get __timeframe() {
        return 60_000
    }

    get __roundLength() {
        return this.testRoundLength ?? super.__roundLength
    }

    __getNextTimestamp(current) {
        return current + 60_000
    }

    async __workerFn() {
        return false
    }
}

/**
 * Runs one round in which every submission is refused, so both attempts run
 * @param {number} timestamp - the round's sync timestamp (no sync delay)
 * @param {number} [roundLength] - round length override; the runner's default when omitted
 * @returns {Promise<{builds: Array<{fee: number, maxTime: number}>, error: Error}>}
 */
async function runRound(timestamp, roundLength) {
    container.settingsManager = {
        appConfig: {keypair: ownKp, publicKey: ownKp.publicKey()},
        nodes: new Map([[ownKp.publicKey(), {pubkey: ownKp.publicKey()}]]), //one node: its own signature is a majority
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc.invalid']})
    }
    const runner = new TestRunner(roundLength)
    runner.isRunning = true
    runner.__payloadMajorityData = {resolve: jest.fn(), promise: Promise.resolve(true)}
    const account = new Account('GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX', '1')
    const builds = []
    const build = async (acc, fee, maxTime) => {
        builds.push({fee, maxTime})
        const inner = {hash: () => Buffer.alloc(32, builds.length), fee, toXdr: () => 'xdr'}
        return new TestTransaction(inner, timestamp, PendingTransactionType.ORACLE_PRICE_UPDATE)
    }
    let error = null
    try {
        await runner.__buildAndSubmitTransaction(build, account, 100, timestamp, 0)
    } catch (e) {
        error = e
    } finally {
        runner.stop()
    }
    return {builds, error}
}

describe('two-attempt rounds', () => {
    beforeEach(() => {
        mockSubmit.mockClear()
        jest.spyOn(Math, 'random').mockReturnValue(0) //no submission jitter
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    test('a one-minute round: attempt 1 until sync + 40 s at the base fee, attempt 2 until sync + 60 s at 8x', async () => {
        const sync = Date.now()
        const {builds, error} = await runRound(sync)
        expect(builds).toEqual([{fee: 100, maxTime: (sync + 40_000) / 1000}, {fee: 800, maxTime: (sync + 60_000) / 1000}])
        expect(error.message).toBe('Failed to submit transaction. See logs for details.')
    })

    test('a five-minute round: attempt 2 runs until the next round, sync + 300 s', async () => {
        const sync = Date.now()
        const {builds} = await runRound(sync, 300_000)
        expect(builds.map(b => b.maxTime)).toEqual([(sync + 40_000) / 1000, (sync + 300_000) / 1000])
        expect(builds.map(b => b.fee)).toEqual([100, 800])
    })

    test('a node joining a five-minute round after attempt 1 ended builds only attempt 2', async () => {
        const sync = Date.now() - 100_000
        const {builds} = await runRound(sync, 300_000)
        expect(builds).toEqual([{fee: 800, maxTime: (sync + 300_000) / 1000}])
    })

    test('a round is skipped as a whole only once its last attempt is over', async () => {
        const live = await runRound(Date.now() - 299_000, 300_000)
        expect(live.builds).toHaveLength(1)
        const over = await runRound(Date.now() - 301_000, 300_000)
        expect(over.builds).toHaveLength(0)
        expect(over.error.message).toBe(RunnerBase.tickSkippedMessage)
    })

    test('the round length defaults to the runner timeframe', () => {
        expect(new TestRunner().__roundLength).toBe(60_000)
    })
})
