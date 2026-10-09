/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const {PendingTransactionBase, PendingTransactionType} = require('@reflector/reflector-shared')

jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({
    setLastProcessedTimestamp: jest.fn(),
    incSubmittedTransactions: jest.fn(),
    setProcessedTx: jest.fn()
}))
jest.mock('../../../src/utils', () => ({
    submitTransaction: jest.fn(),
    getAccount: jest.fn(),
    txTimeoutMessage: 'Transaction timed out',
    isDebugging: () => false,
    //runner-base destructures withDeadline at require time; a pass-through keeps the reads and the build unbounded here
    withDeadline: promise => promise
}))

const container = require('../../../src/domain/container')
const {submitTransaction} = require('../../../src/utils')
const RunnerBase = require('../../../src/domain/runners/runner-base')
const {runnerStoppedMessage} = require('../../../src/domain/runners/runner-base')
const runnerManager = require('../../../src/domain/runners/runner-manager')

const ownKp = Keypair.random()
const peerKps = [Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random()]
const contractId = 'C'.repeat(56)

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
 * @param {number} [seed] - byte the fake transaction hash is filled with
 * @returns {PendingTransactionBase}
 */
function makeTx(seed = 11) {
    const hash = Buffer.alloc(32, seed)
    return new TestTransaction({hash: () => hash, fee: 100, toXdr: () => 'xdr'}, 1_700_000_000_000, PendingTransactionType.ORACLE_PRICE_UPDATE)
}

/**
 * @param {Keypair[]} cluster - node set the runner sees right now
 */
function setCluster(cluster) {
    container.settingsManager.nodes = new Map(cluster.map(kp => [kp.publicKey(), {pubkey: kp.publicKey()}]))
}

/**
 * addSignature fires __trySubmitTransaction without awaiting it, so a submission triggered that way sits behind the
 * 0-1000 ms jitter sleep while the assertions run. Math.random is pinned to 0 below, so one timer tick lets it through.
 * @returns {Promise<void>}
 */
function flushSubmissionJitter() {
    return new Promise(resolve => setTimeout(resolve, 5))
}

/**
 * Runners made by the current test. A test may leave a transaction pending, and its timeout rejects about a minute
 * later - after the run, as an unhandled rejection that kills the process when jest is not force-exited.
 * @type {TestRunner[]}
 */
const runners = []

/**
 * Stops every runner the test made: stop() clears the pending transaction and settles it, which also clears its
 * timeout. The rejection is expected, so it is handled here rather than left unhandled.
 */
function releaseRunners() {
    for (const runner of runners.splice(0)) {
        runner.__pendingTransaction?.submitPromise.catch(() => {})
        runner.stop()
    }
}

/**
 * @param {Keypair[]} [cluster] - node set at build time
 * @returns {TestRunner}
 */
function makeRunner(cluster = [ownKp, peerKps[0], peerKps[1], peerKps[2], peerKps[3]]) {
    container.settingsManager = {
        appConfig: {keypair: ownKp, publicKey: ownKp.publicKey()},
        nodes: new Map(),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']})
    }
    setCluster(cluster)
    const runner = new TestRunner(contractId)
    runner.isRunning = true
    runner.__payloadMajorityData = {resolve: jest.fn()}
    runners.push(runner)
    return runner
}

describe('RunnerBase lifecycle and threshold', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        submitTransaction.mockResolvedValue({envelopeXdr: 'x', createdAt: 1})
        //pin the submission jitter, the only intentional randomness in the runner, so flushSubmissionJitter is exact
        jest.spyOn(Math, 'random').mockReturnValue(0)
    })

    afterEach(() => {
        releaseRunners()
        jest.restoreAllMocks()
    })

    test('stop() rejects the transaction in flight and clears it', async () => {
        const runner = makeRunner()
        const tx = makeTx()
        const pending = runner.__setPendingTransaction(tx, Math.floor(Date.now() / 1000) + 60)
        const settled = pending.submitPromise.catch(e => e.message)

        runner.stop()

        await expect(settled).resolves.toBe(runnerStoppedMessage)
        expect(runner.__pendingTransaction).toBeNull()
    })

    test('a stopped runner does not submit even with a majority', async () => {
        const runner = makeRunner()
        const tx = makeTx()
        runner.__setPendingTransaction(tx, Math.floor(Date.now() / 1000) + 60)
        runner.addSignature(tx.hashHex, peerKps[0].signDecorated(tx.hash), peerKps[0].publicKey())
        runner.isRunning = false
        runner.addSignature(tx.hashHex, peerKps[1].signDecorated(tx.hash), peerKps[1].publicKey())

        await runner.__trySubmitTransaction()
        await flushSubmissionJitter()

        expect(submitTransaction).not.toHaveBeenCalled()
        expect(runner.__pendingTransaction).not.toBeNull() //a stopped runner does not consume the transaction either
    })

    test('a runner stopped during the submission jitter still does not submit', async () => {
        //by the time the jitter sleep starts the transaction has already left __pendingTransaction, so stop() alone
        //cannot abort it - only the re-check after the sleep can
        const runner = makeRunner()
        const tx = makeTx(13)
        const pending = runner.__setPendingTransaction(tx, Math.floor(Date.now() / 1000) + 60)
        const settled = pending.submitPromise.catch(e => e.message)
        runner.addSignature(tx.hashHex, peerKps[0].signDecorated(tx.hash), peerKps[0].publicKey())
        runner.addSignature(tx.hashHex, peerKps[1].signDecorated(tx.hash), peerKps[1].publicKey()) //majority reached

        runner.stop() //lands while the jitter sleep is still pending
        await flushSubmissionJitter()

        expect(submitTransaction).not.toHaveBeenCalled()
        await expect(settled).resolves.toBe(runnerStoppedMessage)
    })

    test('a runner stopped mid-flight abandons the retry loop', async () => {
        const runner = makeRunner()
        const buildTxFn = jest.fn()
        const account = {accountId: () => 'GACCOUNT', sequenceNumber: () => '1'}
        runner.isRunning = false

        await expect(runner.__buildAndSubmitTransaction(buildTxFn, account, 100, Date.now()))
            .rejects.toThrow(runnerStoppedMessage)
        expect(buildTxFn).not.toHaveBeenCalled()
    })

    test('a cluster that shrinks mid-flight does not lower the threshold', async () => {
        const runner = makeRunner() //5 nodes, majority 3
        const tx = makeTx()
        runner.__setPendingTransaction(tx, Math.floor(Date.now() / 1000) + 60)
        runner.addSignature(tx.hashHex, peerKps[0].signDecorated(tx.hash), peerKps[0].publicKey())
        expect(tx.signatures).toHaveLength(2)

        setCluster([ownKp, peerKps[0], peerKps[1]]) //now 3 nodes, live majority 2

        await runner.__trySubmitTransaction()

        expect(submitTransaction).not.toHaveBeenCalled()
        expect(runner.__pendingTransaction).not.toBeNull()
    })

    test('a cluster that grows mid-flight still submits under the captured threshold', async () => {
        const runner = makeRunner([ownKp, peerKps[0], peerKps[1]]) //3 nodes, majority 2
        const tx = makeTx()
        runner.__setPendingTransaction(tx, Math.floor(Date.now() / 1000) + 60)

        setCluster([ownKp, ...peerKps]) //now 7 nodes, live majority 4
        runner.addSignature(tx.hashHex, peerKps[0].signDecorated(tx.hash), peerKps[0].publicKey())

        await runner.__trySubmitTransaction()
        await flushSubmissionJitter() //the submission was triggered from addSignature, which does not await it

        expect(submitTransaction).toHaveBeenCalledTimes(1)
        expect(submitTransaction.mock.calls[0][3]).toHaveLength(2) //getMajoritySignatures(3)
    })

    test('RunnerManager.remove detaches the runner and rejects its pending transaction', async () => {
        const runner = makeRunner()
        runner.contractId = contractId
        runnerManager.runners.set(contractId, runner)
        const tx = makeTx(12)
        const pending = runner.__setPendingTransaction(tx, Math.floor(Date.now() / 1000) + 60)
        const settled = pending.submitPromise.catch(e => e.message)

        runnerManager.remove(contractId)

        expect(runnerManager.has(contractId)).toBe(false)
        expect(runner.isRunning).toBe(false)
        await expect(settled).resolves.toBe(runnerStoppedMessage)
    })
})
