/*eslint-disable no-undef, class-methods-use-this, require-await */
const {Keypair} = require('@stellar/stellar-sdk')
const {PendingTransactionBase, PendingTransactionType} = require('@reflector/reflector-shared')

const mockStatistics = {
    setLastProcessedTimestamp: jest.fn(),
    incSubmittedTransactions: jest.fn(),
    setProcessedTx: jest.fn()
}
const mockSubmit = jest.fn(async () => ({envelopeXdr: 'AAAA', status: 'SUCCESS'}))

jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => mockStatistics)
jest.mock('../../../src/utils', () => ({
    submitTransaction: (...args) => mockSubmit(...args),
    txTimeoutMessage: 'Tx timed out.',
    getAccount: jest.fn(),
    isDebugging: () => false,
    //runner-base destructures withDeadline at require time; a pass-through keeps the reads and the build unbounded here
    withDeadline: promise => promise
}))

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk')
    //__buildAndSubmitTransaction re-parses the submitted envelope to decide whether this node's own signature is on
    //it. The fake carries one hint that matches anything, so that branch really runs and the restore assertions
    //below discriminate instead of passing against unfixed code as well.
    class FakeTransaction {
        constructor() {
            this.signatures = [{hint: {equals: () => true}}]
        }

        hash() {
            return Buffer.alloc(32, 7)
        }
    }
    return {...actual, Transaction: FakeTransaction}
})

const {Account} = require('@stellar/stellar-sdk')
const container = require('../../../src/domain/container')
const RunnerBase = require('../../../src/domain/runners/runner-base')

const ownKp = Keypair.random()
const contractId = 'C'.repeat(56)
//hash of the FakeTransaction the runner re-parses from the submitted envelope
const processedHashHex = Buffer.alloc(32, 7).toString('hex')

class TestTransaction extends PendingTransactionBase {}

class TestRunner extends RunnerBase {
    get __timeframe() {
        return 60000
    }

    __getNextTimestamp(current) {
        return current + 60000
    }

    async __workerFn() {
        return false
    }
}

/**
 * A real reflector-shared pending transaction over a fake inner transaction, built the way
 * makeTx in tests/domain/runners/runner-lifecycle.test.js builds one, so the next change to __setPendingTransaction
 * breaks this file loudly rather than silently. A hand-rolled object cannot satisfy it: the runner
 * calls tx.setAllowedSigners(signers) and treats a falsy tx.addSignature(...) as "this node is not in the cluster".
 * The flag is attached the way oracle-client 7.2.0 attaches it in getRestoreTransaction (src/rpc-helper.js): a
 * non-enumerable own property of the sdk Transaction, which the shared wrapper holds in .transaction.
 * @param {boolean} isRestore - whether the client substituted a restore transaction
 * @returns {PendingTransactionBase}
 */
function pendingTx(isRestore) {
    const inner = {hash: () => Buffer.alloc(32, 1), fee: 100, toXdr: () => 'xdr'}
    if (isRestore)
        Object.defineProperty(inner, 'isRestore', {value: true, enumerable: false})
    return new TestTransaction(inner, 1_700_000_000_000, PendingTransactionType.ORACLE_PRICE_UPDATE)
}

/**
 * @param {...boolean} attempts - for each build attempt in turn, whether the built transaction carries the flag
 * @returns {Promise<TestRunner>} the runner after one build-and-submit round
 */
async function runAttempts(...attempts) {
    container.settingsManager = {
        appConfig: {keypair: ownKp, publicKey: ownKp.publicKey()},
        //a one-node cluster: getMajority(1) is 1, so this node's own signature is already a majority and the
        //attempt submits without a peer. publicKey is load-bearing - addSignature validates it with StrKey.
        nodes: new Map([[ownKp.publicKey(), {pubkey: ownKp.publicKey()}]]),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc.invalid']})
    }
    const runner = new TestRunner(contractId)
    runner.isRunning = true //__buildAndSubmitTransaction abandons the loop on a stopped runner
    runner.__payloadMajorityData = {resolve: jest.fn(), promise: Promise.resolve(true)}
    const account = new Account('GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX', '1')
    let attempt = 0
    try {
        await runner.__buildAndSubmitTransaction(async () => pendingTx(attempts[attempt++]), account, 100, Date.now(), 0)
    } finally {
        runner.stop()
    }
    return runner
}

describe('restore transaction handling', () => {
    beforeEach(() => {
        mockStatistics.setLastProcessedTimestamp.mockClear()
        mockStatistics.incSubmittedTransactions.mockClear()
        mockStatistics.setProcessedTx.mockClear()
        mockSubmit.mockClear()
        //pin the submission jitter, the runner's only intentional randomness, so no attempt waits a second
        jest.spyOn(Math, 'random').mockReturnValue(0)
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    test('the fixture flag has the oracle-client shape: set, but not enumerable', () => {
        const tx = pendingTx(true)
        expect(tx.transaction.isRestore).toBe(true)
        expect(Object.keys(tx.transaction)).not.toContain('isRestore')
        expect({...tx.transaction}.isRestore).toBeUndefined()
    })

    test('a restore transaction is still submitted', async () => {
        await runAttempts(true)
        expect(mockSubmit).toHaveBeenCalledTimes(1)
        expect(mockSubmit.mock.calls[0][2].transaction.isRestore).toBe(true)
    })

    test('a restore transaction is not counted as a processed transaction', async () => {
        await runAttempts(true)
        expect(mockStatistics.setProcessedTx).not.toHaveBeenCalled()
        expect(mockStatistics.incSubmittedTransactions).not.toHaveBeenCalled()
    })

    test('a restore transaction marks the runner so the tick is not marked processed', async () => {
        const runner = await runAttempts(true)
        expect(runner.__isRestoreSubstitution).toBe(true)
    })

    test('the requested transaction is counted as before', async () => {
        const runner = await runAttempts(false)
        expect(runner.__isRestoreSubstitution).toBe(false)
        expect(mockStatistics.setProcessedTx).toHaveBeenCalledTimes(1)
        expect(mockStatistics.setProcessedTx).toHaveBeenCalledWith(contractId, processedHashHex)
        expect(mockStatistics.incSubmittedTransactions).toHaveBeenCalledTimes(1)
        expect(mockStatistics.incSubmittedTransactions).toHaveBeenCalledWith(contractId, undefined)
    })

    test('a failed restore attempt does not mark the runner when the retry lands the requested update', async () => {
        mockSubmit.mockImplementationOnce(async () => {
            throw new Error('restore submission failed')
        })
        const runner = await runAttempts(true, false)
        expect(mockSubmit).toHaveBeenCalledTimes(2)
        expect(mockSubmit.mock.calls[0][2].transaction.isRestore).toBe(true)
        expect(mockSubmit.mock.calls[1][2].transaction.isRestore).toBeUndefined()
        expect(runner.__isRestoreSubstitution).toBe(false)
        expect(mockStatistics.setProcessedTx).toHaveBeenCalledTimes(1)
        expect(mockStatistics.incSubmittedTransactions).toHaveBeenCalledTimes(1)
    })

    test('worker() does not advance the last processed timestamp after a restore', async () => {
        const runner = new TestRunner(contractId)
        runner.isRunning = true
        runner.__workerFn = async () => {
            runner.__isRestoreSubstitution = true
            return true
        }
        await runner.worker(1_700_000_000_000)
        runner.stop()
        expect(mockStatistics.setLastProcessedTimestamp).not.toHaveBeenCalled()
    })

    test('worker() clears a restore mark left by the previous tick', async () => {
        const runner = new TestRunner(contractId)
        runner.isRunning = true
        runner.__isRestoreSubstitution = true
        runner.__workerFn = async () => true
        await runner.worker(1_700_000_000_000)
        runner.stop()
        expect(runner.__isRestoreSubstitution).toBe(false)
        expect(mockStatistics.setLastProcessedTimestamp).toHaveBeenCalledWith(contractId, undefined, 1_700_000_000_000)
    })

    test('worker() advances the last processed timestamp on a normal tick', async () => {
        const runner = new TestRunner(contractId)
        runner.isRunning = true
        runner.__workerFn = async () => true
        await runner.worker(1_700_000_000_000)
        runner.stop()
        expect(mockStatistics.setLastProcessedTimestamp).toHaveBeenCalledWith(contractId, undefined, 1_700_000_000_000)
    })
})
