/*eslint-disable no-undef, class-methods-use-this, require-await */
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const {PendingTransactionBase, PendingTransactionType} = require('@reflector/reflector-shared')

const mockSubmit = jest.fn(async () => ({envelopeXdr: 'AAAA', status: 'SUCCESS'}))

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
    //the real deadline: a build that hangs has to fail the way it does on a node
    withDeadline: (...args) => jest.requireActual('../../../src/utils/utils').withDeadline(...args)
}))

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk')
    //a landed round re-parses the submitted envelope; this stands in for it
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
const {makeServerRequest, __resetUrlPreference} = require('@reflector/oracle-client/src/rpc-helper')
const logger = require('../../../src/logger')
const container = require('../../../src/domain/container')
const RunnerBase = require('../../../src/domain/runners/runner-base')

const ownKp = Keypair.random()
const contractId = 'C'.repeat(56)
const T = 1_800_000_000_000 //on the minute

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

//what oracle-client throws when every rpc url failed
const networkFailure = () => Promise.reject(new Error('Failed to make request.'))
//what oracle-client throws when the simulation refused the transaction: the rpc's error string, unchanged
const rejection = () => Promise.reject(new Error('HostError: Error(Contract, #5)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Contract, #5)]'))
const hang = () => new Promise(() => {})
const built = () => 'built'

/**
 * Starts one round on a single-node cluster, where the node's own signature is a majority
 * @param {Array<Function>} behaviours - what each build does in turn: networkFailure, rejection, hang or built
 * @param {number} sync - the round's sync timestamp
 * @param {number} [roundLength] - round length override
 * @returns {{runner: TestRunner, builds: Array<{at: number, fee: number, maxTime: number}>, outcome: Promise<Object>}} the
 * outcome settles to {value} when the round lands and {error} when it fails
 */
function startRound(behaviours, sync, roundLength) {
    container.settingsManager = {
        appConfig: {keypair: ownKp, publicKey: ownKp.publicKey()},
        nodes: new Map([[ownKp.publicKey(), {pubkey: ownKp.publicKey()}]]),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc.invalid']})
    }
    const runner = new TestRunner(roundLength)
    runner.isRunning = true
    runner.__payloadMajorityData = {resolve: jest.fn(), promise: Promise.resolve(true)}
    const account = new Account('GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX', '1')
    const builds = []
    const build = async (acc, fee, maxTime) => {
        builds.push({at: Date.now() - T, fee, maxTime})
        const behaviour = behaviours[Math.min(builds.length, behaviours.length) - 1]
        const result = await behaviour()
        //the hash depends on the fee and maxTime alone, as a real build's does on its inputs
        const hash = createHash('sha256').update(`${acc.sequenceNumber()}:${fee}:${maxTime}`).digest()
        return result === 'built'
            ? new TestTransaction({hash: () => hash, fee, toXdr: () => 'xdr'}, sync, PendingTransactionType.ORACLE_PRICE_UPDATE)
            : result
    }
    const outcome = runner.__buildAndSubmitTransaction(build, account, 100, sync, 0)
        .then(value => ({value}), error => ({error}))
    return {runner, builds, outcome}
}

describe('a failed build is built again while its attempt lasts', () => {
    beforeEach(() => {
        jest.useFakeTimers({now: T})
        jest.spyOn(Math, 'random').mockReturnValue(0) //no submission jitter
        mockSubmit.mockClear()
        logger.warn.mockClear()
        logger.error.mockClear()
    })

    afterEach(() => {
        jest.useRealTimers()
        jest.restoreAllMocks()
    })

    test('attempt 1: a network failure is built again 5 s later at the same fee and maxTime, and the round lands', async () => {
        const {builds, outcome} = startRound([networkFailure, built], T)
        await jest.advanceTimersByTimeAsync(6_000) //the retry at 5 s, then the submission
        const {value, error} = await outcome
        expect(error).toBeUndefined()
        expect(value.response).toEqual({envelopeXdr: 'AAAA', status: 'SUCCESS'})
        const maxTime = (T + 40_000) / 1000
        expect(builds).toEqual([{at: 0, fee: 100, maxTime}, {at: 5_000, fee: 100, maxTime}])
        expect(mockSubmit).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'Transaction build failed; building it again', submitAttempt: 0, reason: 'Failed to make request.'}))
    })

    test('attempt 2 of a five-minute round (the e2e case): one network failure no longer ends the round', async () => {
        const sync = T - 41_000 //attempt 1 is over
        const {builds, outcome} = startRound([networkFailure, built], sync, 300_000)
        await jest.advanceTimersByTimeAsync(6_000)
        const {error} = await outcome
        expect(error).toBeUndefined()
        const maxTime = (sync + 300_000) / 1000
        expect(builds).toEqual([{at: 0, fee: 800, maxTime}, {at: 5_000, fee: 800, maxTime}])
        expect(mockSubmit).toHaveBeenCalledTimes(1)
    })

    test('a build that hits its deadline is built again', async () => {
        const {builds, outcome} = startRound([hang, built], T)
        await jest.advanceTimersByTimeAsync(21_000) //15 s deadline, the 5 s pause, then the submission
        const {error} = await outcome
        expect(error).toBeUndefined()
        expect(builds.map(b => [b.at, b.fee])).toEqual([[0, 100], [20_000, 100]])
    })

    test('the builds stop once a pause would end past the attempt\'s maxTime; the round fails with one error logged', async () => {
        const sync = T - 41_000 //a one-minute round in attempt 2: 19 s left
        const {builds, outcome} = startRound([networkFailure], sync)
        await jest.advanceTimersByTimeAsync(20_000)
        const {error} = await outcome
        expect(error.message).toBe('Failed to submit transaction. See logs for details.')
        expect(builds.map(b => b.at)).toEqual([0, 5_000, 10_000, 15_000])
        expect(builds.every(b => b.fee === 800)).toBe(true)
        expect(logger.warn).toHaveBeenCalledTimes(3)
        //one line for the four failed builds; attempt 1, already over, adds its own 'Tx timed out.'
        expect(logger.error.mock.calls.filter(([e]) => e?.message === 'Failed to make request.')).toHaveLength(1)
    })

    test('attempt 1 builds again until its own window ends, then attempt 2 starts', async () => {
        const {builds, outcome} = startRound([networkFailure, networkFailure, networkFailure, networkFailure,
            networkFailure, networkFailure, networkFailure, networkFailure, built], T)
        await jest.advanceTimersByTimeAsync(41_000)
        const {error} = await outcome
        expect(error).toBeUndefined()
        const attempt1 = builds.filter(b => b.fee === 100)
        expect(attempt1.map(b => b.at)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000])
        expect(builds.filter(b => b.fee === 800)).toEqual([{at: 35_000, fee: 800, maxTime: (T + 60_000) / 1000}])
    })

    test('a simulation rejection is not built again: the round moves straight to attempt 2', async () => {
        const {builds, outcome} = startRound([rejection], T)
        await jest.advanceTimersByTimeAsync(0)
        const {error} = await outcome
        expect(error.message).toBe('Failed to submit transaction. See logs for details.')
        expect(builds.map(b => [b.at, b.fee])).toEqual([[0, 100], [0, 800]])
        expect(logger.warn).not.toHaveBeenCalled()
    })

    test('a runner stopped during the pause builds nothing more', async () => {
        const {runner, builds, outcome} = startRound([networkFailure, built], T)
        await jest.advanceTimersByTimeAsync(1_000)
        runner.stop()
        await jest.advanceTimersByTimeAsync(5_000)
        const {error} = await outcome
        expect(error.message).toBe(RunnerBase.runnerStoppedMessage)
        expect(builds).toHaveLength(1)
        expect(mockSubmit).not.toHaveBeenCalled()
    })

    describe('several rpc urls: a build asks each of them before it counts as failed', () => {
        const FIRST_URL = 'http://rpc-first/'
        const SECOND_URL = 'http://rpc-second/'
        let requests

        /**
         * A build whose simulation goes through oracle-client's own url walk, the one every real build uses. A refused
         * url fails at once, a hung one at the deadline oracle-client puts on the http client, and a healthy one
         * answers after 200 ms
         * @param {{refused: Set<string>, hung: Set<string>}} urls - the urls that do not answer
         * @returns {Function} a build behaviour for startRound
         */
        function simulateThrough({refused = new Set(), hung = new Set()}) {
            return () => makeServerRequest([FIRST_URL, SECOND_URL], server => {
                const url = String(server.serverURL)
                requests.push([url, Date.now() - T])
                if (refused.has(url))
                    return Promise.reject(new Error('fetch failed'))
                const {timeout} = server.httpClient.defaults
                if (hung.has(url))
                    return new Promise((resolve, reject) => setTimeout(() => reject(new Error(`timeout of ${timeout}ms exceeded`)), timeout))
                return new Promise(resolve => setTimeout(resolve, 200))
            }).then(built)
        }

        beforeEach(() => {
            __resetUrlPreference() //module state of oracle-client, shared by every test in this process
            requests = []
            jest.spyOn(console, 'debug').mockImplementation(() => {}) //oracle-client logs each failed url
        })

        test('a refused first url: the same build asks the second, and nothing is built again', async () => {
            const {builds, outcome} = startRound([simulateThrough({refused: new Set([FIRST_URL])})], T)
            await jest.advanceTimersByTimeAsync(1_000)
            const {error} = await outcome
            expect(error).toBeUndefined()
            expect(requests).toEqual([[FIRST_URL, 0], [SECOND_URL, 0]])
            expect(builds).toHaveLength(1)
            expect(logger.warn).not.toHaveBeenCalled()
            expect(mockSubmit).toHaveBeenCalledTimes(1)
        })

        test('a hung first url outlasts the build deadline; the abandoned build fails over, and the rebuild starts at the url that answered', async () => {
            const {builds, outcome} = startRound([simulateThrough({hung: new Set([FIRST_URL])})], T)
            await jest.advanceTimersByTimeAsync(21_000)
            const {error} = await outcome
            expect(error).toBeUndefined()
            //the first url's 15 s deadline is the build's own: the build ends before the second url answers at 15.2 s,
            //and that answer makes it the url the next build asks first
            expect(requests).toEqual([[FIRST_URL, 0], [SECOND_URL, 15_000], [SECOND_URL, 20_000]])
            expect(builds.map(b => [b.at, b.fee])).toEqual([[0, 100], [20_000, 100]])
            expect(mockSubmit).toHaveBeenCalledTimes(1)
        })
    })
})
