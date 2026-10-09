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

const container = require('../../../src/domain/container')
const RunnerBase = require('../../../src/domain/runners/runner-base')

const ownKp = Keypair.random()
const peerKps = [Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random()]
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
 * @returns {PendingTransactionBase} a pending transaction over a deterministic hash
 */
function makeTx(seed = 7) {
    const hash = Buffer.alloc(32, seed)
    return new TestTransaction({hash: () => hash}, 1_700_000_000_000, PendingTransactionType.ORACLE_PRICE_UPDATE)
}

/**
 * @returns {number} a maxTime a minute ahead, in seconds, so the pending transaction's own timeout never fires
 */
function futureMaxTime() {
    return Math.floor(Date.now() / 1000) + 60
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
 * @param {Keypair[]} [cluster] - node set the runner sees
 * @returns {TestRunner} a runner with the container wired and submission stubbed out
 */
function makeRunner(cluster = [ownKp, ...peerKps]) {
    container.settingsManager = {
        appConfig: {keypair: ownKp, publicKey: ownKp.publicKey()},
        nodes: new Map(cluster.map(kp => [kp.publicKey(), {pubkey: kp.publicKey()}])),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']})
    }
    const runner = new TestRunner(contractId)
    runner.isRunning = true
    runner.__payloadMajorityData = {resolve: jest.fn()}
    runner.__trySubmitTransaction = jest.fn()
    runners.push(runner)
    return runner
}

describe('RunnerBase.addSignature', () => {
    afterEach(() => {
        releaseRunners()
    })

    test('a peer that repeats its own valid signature never reaches majority alone', () => {
        const runner = makeRunner()
        const tx = makeTx()
        runner.__setPendingTransaction(tx, futureMaxTime())
        const peer = peerKps[0]
        const signature = peer.signDecorated(tx.hash)

        runner.addSignature(tx.hashHex, signature, peer.publicKey())
        runner.addSignature(tx.hashHex, peer.signDecorated(tx.hash), peer.publicKey())
        runner.addSignature(tx.hashHex, signature, peer.publicKey())

        //own signature plus one distinct peer, against a 5-node majority of 3
        expect(tx.signatures).toHaveLength(2)
        expect(tx.isReadyToSubmit(5)).toBe(false)
    })

    test('distinct peers reach majority and getMajoritySignatures returns distinct signers', () => {
        const runner = makeRunner()
        const tx = makeTx()
        runner.__setPendingTransaction(tx, futureMaxTime())

        runner.addSignature(tx.hashHex, peerKps[0].signDecorated(tx.hash), peerKps[0].publicKey())
        runner.addSignature(tx.hashHex, peerKps[1].signDecorated(tx.hash), peerKps[1].publicKey())

        expect(tx.signatures).toHaveLength(3)
        expect(tx.isReadyToSubmit(5)).toBe(true)
        const hints = tx.getMajoritySignatures(5).map(s => Buffer.from(s.hint.toXDR()).toString('hex'))
        expect(new Set(hints).size).toBe(3)
    })

    test('a signature presented under the wrong peer key is refused', () => {
        const runner = makeRunner()
        const tx = makeTx()
        runner.__setPendingTransaction(tx, futureMaxTime())

        //peer 1 relays peer 0's signature under its own pubkey
        runner.addSignature(tx.hashHex, peerKps[0].signDecorated(tx.hash), peerKps[1].publicKey())

        expect(tx.signatures).toHaveLength(1)
    })

    test('a signer outside the captured node set is refused', () => {
        const runner = makeRunner([ownKp, peerKps[0], peerKps[1]])
        const tx = makeTx()
        runner.__setPendingTransaction(tx, futureMaxTime())
        const outsider = Keypair.random()

        runner.addSignature(tx.hashHex, outsider.signDecorated(tx.hash), outsider.publicKey())

        expect(tx.signatures).toHaveLength(1)
    })

    test('a malformed hash is ignored and never allocates a bucket', () => {
        const runner = makeRunner()
        const peer = peerKps[0]
        const signature = peer.signDecorated(Buffer.alloc(32, 1))

        expect(() => runner.addSignature('__proto__', signature, peer.publicKey())).not.toThrow()
        expect(() => runner.addSignature('constructor', signature, peer.publicKey())).not.toThrow()
        expect(() => runner.addSignature('NOTHEX'.repeat(10), signature, peer.publicKey())).not.toThrow()
        expect(() => runner.addSignature(undefined, signature, peer.publicKey())).not.toThrow()

        expect(runner.__pendingSignatures.size).toBe(0)
    })

    test('one peer cannot open more than its quota of buffered hashes', () => {
        const runner = makeRunner()
        const peer = peerKps[0]
        for (let i = 0; i < 50; i++) {
            const hash = Buffer.alloc(32, 0)
            hash.writeUInt32BE(i, 0)
            runner.addSignature(hash.toString('hex'), peer.signDecorated(hash), peer.publicKey())
        }

        expect(runner.__pendingSignatures.size).toBe(16)
    })

    test('a node outside its own cluster set refuses to build a transaction', () => {
        //the window between a config update that removes this node and the runner actually stopping: setAllowedSigners
        //now excludes this node, addSignature returns false, and an unchecked false would leave tx.signatures empty and
        //make broadcastSignature throw on signatures[0]
        const runner = makeRunner(peerKps) //own key is not in the node set

        expect(() => runner.__setPendingTransaction(makeTx(21), futureMaxTime())).toThrow(/not in the current cluster node set/)
    })

    test('buffered signatures are verified against the buffering peer when the transaction arrives', () => {
        const runner = makeRunner()
        const tx = makeTx(9)
        runner.addSignature(tx.hashHex, peerKps[0].signDecorated(tx.hash), peerKps[0].publicKey())
        //a relayed signature buffered under the wrong key must not survive the transfer
        runner.addSignature(tx.hashHex, peerKps[2].signDecorated(tx.hash), peerKps[1].publicKey())

        runner.__setPendingTransaction(tx, futureMaxTime())

        expect(tx.signatures).toHaveLength(2) //own plus peer 0
        expect(runner.__pendingSignatures.size).toBe(0)
    })

    test('dropping a bucket releases its owner quota', () => {
        const runner = makeRunner()
        const peer = peerKps[0]
        const hash = Buffer.alloc(32, 3)
        runner.addSignature(hash.toString('hex'), peer.signDecorated(hash), peer.publicKey())
        expect(runner.__pendingSignatures.size).toBe(1)

        runner.__dropPendingSignatures(hash.toString('hex'))

        expect(runner.__pendingSignatures.size).toBe(0)
        expect(runner.__pendingSignaturesByPeer.size).toBe(0)
    })
})
