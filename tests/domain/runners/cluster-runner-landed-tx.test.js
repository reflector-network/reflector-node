/*eslint-disable no-undef */
jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({
    setLastProcessedTimestamp: jest.fn(),
    incSubmittedTransactions: jest.fn(),
    setProcessedTx: jest.fn()
}))
jest.mock('../../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 1),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways'}
}))
//the real utils, so the real build deadline runs; only the system account read is under the test's control
jest.mock('../../../src/utils', () => ({...jest.requireActual('../../../src/utils'), getAccount: jest.fn()}))
jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared'),
    buildUpdateTransaction: jest.fn()
}))

const {Account, Keypair, Operation, TransactionBuilder} = require('@stellar/stellar-sdk')
const {buildUpdateTransaction} = require('@reflector/reflector-shared')
const {getAccount} = require('../../../src/utils')
const container = require('../../../src/domain/container')
const logger = require('../../../src/logger')
const ClusterRunner = require('../../../src/domain/runners/cluster-runner')

const NETWORK = 'Test SDF Network ; September 2015'
const TICK = 1_700_000_100_000
const systemKp = Keypair.random()
const account = new Account(systemKp.publicKey(), '1')
//the envelope the landed submission reports; runner-base re-parses it for its statistics
const envelopeXdr = new TransactionBuilder(new Account(systemKp.publicKey(), '1'), {fee: '100', networkPassphrase: NETWORK})
    .addOperation(Operation.bumpSequence({bumpTo: '2'}))
    .setTimeout(0)
    .build()
    .toEnvelope()
    .toXDR('base64')

/**
 * A built cluster update, shaped like reflector-shared's WasmPendingTransaction
 * @param {string} label - tells the attempts apart
 * @param {boolean} hasMoreTxns - whether the update still has contracts left after this one
 * @returns {object}
 */
function builtUpdate(label, hasMoreTxns) {
    return {label, hasMoreTxns, type: 'wasm', hashHex: label, transaction: {toXdr: () => label}}
}

/**
 * Makes attempt 0's build finish only after its deadline, attempt 1's at once, and lands attempt 1 5 s later
 * @param {boolean} lateFlag - hasMoreTxns of the abandoned attempt 0 build, which finishes at 17 s
 * @param {boolean} landedFlag - hasMoreTxns of the attempt 1 build, the one that lands
 * @returns {ClusterRunner}
 */
function runnerWithSlowFirstBuild(lateFlag, landedFlag) {
    buildUpdateTransaction
        .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(builtUpdate('attempt-0', lateFlag)), 17_000)))
        .mockImplementationOnce(() => Promise.resolve(builtUpdate('attempt-1', landedFlag)))
    const runner = new ClusterRunner()
    runner.isRunning = true
    runner.__trySubmitTransaction = jest.fn()
    runner.__setPendingTransaction = jest.fn(() => ({
        submitPromise: new Promise(resolve => setTimeout(() => resolve({envelopeXdr, createdAt: 1}), 5_000))
    }))
    return runner
}

beforeEach(() => {
    jest.useFakeTimers({now: TICK})
    buildUpdateTransaction.mockReset()
    getAccount.mockReset()
    getAccount.mockResolvedValue(account)
    container.settingsManager = {
        config: {nodes: new Map([['A', {}]]), systemAccount: systemKp.publicKey()},
        //a pending update whose switch time has passed, so the tick itself is the sync timestamp
        pendingConfig: {timestamp: TICK - 60_000, allowEarlySubmission: false, config: {nodes: new Map([['A', {}]]), minDate: 0}, signatures: []},
        appConfig: {keypair: Keypair.random()},
        applyPendingUpdate: jest.fn(() => Promise.resolve()),
        getBlockchainConnectorSettings: () => ({networkPassphrase: NETWORK, sorobanRpc: ['http://rpc.invalid']})
    }
})

afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
})

describe('the pending config is applied from the transaction that landed, never from an abandoned build', () => {
    test('a build abandoned by its deadline that finishes late cannot apply the config while contracts remain', async () => {
        const runner = runnerWithSlowFirstBuild(false, true)
        const worker = runner.__workerFn(TICK)

        await jest.advanceTimersByTimeAsync(15_000)
        //attempt 0 gave up at its 15 s deadline and attempt 1 built and is waiting for the cluster
        expect(runner.__setPendingTransaction.mock.calls.map(([tx]) => tx.label)).toEqual(['attempt-1'])
        await jest.advanceTimersByTimeAsync(10_000) //attempt 0's build finishes at 17 s, attempt 1 lands at 20 s

        await expect(worker).resolves.toBe(true)
        expect(buildUpdateTransaction).toHaveBeenCalledTimes(2)
        //attempt 1 said more contracts remain; the late attempt 0 result must not override it
        expect(container.settingsManager.applyPendingUpdate).not.toHaveBeenCalled()
    })

    test('the landed transaction that completes the update applies the config once, whatever a late build says', async () => {
        const runner = runnerWithSlowFirstBuild(true, false)
        const worker = runner.__workerFn(TICK)
        await jest.advanceTimersByTimeAsync(25_000)

        await expect(worker).resolves.toBe(true)
        expect(runner.__setPendingTransaction.mock.calls.map(([tx]) => tx.label)).toEqual(['attempt-1'])
        expect(container.settingsManager.applyPendingUpdate).toHaveBeenCalledTimes(1)
    })

    test('an update with nothing left to submit on chain applies the config', async () => {
        buildUpdateTransaction.mockResolvedValueOnce(null)
        const runner = new ClusterRunner()
        runner.isRunning = true
        runner.__setPendingTransaction = jest.fn()

        await expect(runner.__workerFn(TICK)).resolves.toBe(true)
        expect(runner.__setPendingTransaction).not.toHaveBeenCalled()
        expect(container.settingsManager.applyPendingUpdate).toHaveBeenCalledTimes(1)
    })
})

describe('a footprint restore that lands in place of the cluster update keeps the pending config', () => {
    /**
     * A built cluster update whose simulation demanded a restore: oracle-client 7.2.0 hands back the restore
     * transaction flagged with a non-enumerable isRestore, and reflector-shared wraps it like any other update
     * @returns {object}
     */
    function landedRestore() {
        const transaction = {toXdr: () => 'restore'}
        Object.defineProperty(transaction, 'isRestore', {value: true, enumerable: false})
        return {label: 'restore', hasMoreTxns: false, type: 'wasm', hashHex: 'restore', transaction}
    }

    /**
     * @returns {ClusterRunner} a running runner whose submissions land at once
     */
    function landingRunner() {
        const runner = new ClusterRunner()
        runner.isRunning = true
        runner.__trySubmitTransaction = jest.fn()
        runner.__setPendingTransaction = jest.fn(() => ({submitPromise: Promise.resolve({envelopeXdr, createdAt: 1})}))
        return runner
    }

    test('the restore tick does not apply the config; the next tick lands the real update and applies it once', async () => {
        const {pendingConfig} = container.settingsManager
        const runner = landingRunner()
        logger.warn.mockClear()

        buildUpdateTransaction.mockResolvedValueOnce(landedRestore())
        await runner.worker(TICK)

        expect(runner.__setPendingTransaction.mock.calls.map(([tx]) => tx.label)).toEqual(['restore'])
        expect(container.settingsManager.applyPendingUpdate).not.toHaveBeenCalled()
        expect(container.settingsManager.pendingConfig).toBe(pendingConfig)
        //the restore bookkeeping saw the same landed restore, so the two cannot disagree about this tick
        expect(runner.__isRestoreSubstitution).toBe(true)
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'A footprint restore landed instead of the cluster update; the pending config is kept for the next tick',
            hash: 'restore'
        }))

        buildUpdateTransaction.mockResolvedValueOnce(builtUpdate('real-update', false))
        await runner.worker(TICK + 120_000)

        expect(runner.__setPendingTransaction.mock.calls.map(([tx]) => tx.label)).toEqual(['restore', 'real-update'])
        expect(runner.__isRestoreSubstitution).toBe(false)
        expect(container.settingsManager.applyPendingUpdate).toHaveBeenCalledTimes(1)
    })

    test('a restore that lands while the update still has contracts left does not apply the config either', async () => {
        const runner = landingRunner()
        logger.warn.mockClear()
        const restore = landedRestore()
        restore.hasMoreTxns = true
        buildUpdateTransaction.mockResolvedValueOnce(restore)

        await expect(runner.__workerFn(TICK)).resolves.toBe(true)
        expect(container.settingsManager.applyPendingUpdate).not.toHaveBeenCalled()
        //still reported as a restore, not silently taken for a partial update
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'A footprint restore landed instead of the cluster update; the pending config is kept for the next tick'
        }))
    })
})
