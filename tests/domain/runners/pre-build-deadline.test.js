/*eslint-disable no-undef */
jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn(), setLastSubscriptionData: jest.fn()}))
jest.mock('../../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 1),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways'}
}))
jest.mock('../../../src/domain/subscriptions/subscriptions-data-manager', () => ({
    addManager: jest.fn(),
    getManager: jest.fn(),
    removeManager: jest.fn(),
    getAllSubscriptions: jest.fn(() => [])
}))
//the real utils, so the real withDeadline runs; only the account read is under the test's control
jest.mock('../../../src/utils', () => ({...jest.requireActual('../../../src/utils'), getAccount: jest.fn()}))
jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared'),
    getContractState: jest.fn(),
    getOracleContractState: jest.fn()
}))

const {ContractTypes, getContractState, getOracleContractState} = require('@reflector/reflector-shared')
const {getAccount} = require('../../../src/utils')
const container = require('../../../src/domain/container')
const logger = require('../../../src/logger')
const nodesManager = require('../../../src/domain/nodes/nodes-manager')
const {getManager} = require('../../../src/domain/subscriptions/subscriptions-data-manager')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')
const ClusterRunner = require('../../../src/domain/runners/cluster-runner')
const DAORunner = require('../../../src/domain/runners/dao-runner')
const SubscriptionsRunner = require('../../../src/domain/runners/subscriptions-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const ADMIN = 'GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX'
const TICK = 1_700_000_100_000
const account = {accountId: () => ADMIN, sequenceNumber: () => '1'}
const hang = () => new Promise(() => {})

beforeEach(() => {
    jest.useFakeTimers()
    getAccount.mockReset()
    getContractState.mockReset()
    getOracleContractState.mockReset()
    nodesManager.broadcast.mockClear()
    container.settingsManager = {
        config: {nodes: new Map([['A', {}]]), systemAccount: ADMIN},
        //a pending update whose switch time has passed, so ClusterRunner goes on to read the system account
        pendingConfig: {timestamp: TICK - 60_000, allowEarlySubmission: false, config: {nodes: new Map([['A', {}]]), minDate: 0}, signatures: []},
        applyPendingUpdate: jest.fn(() => Promise.resolve()),
        getContractConfig: () => ({contractId: CONTRACT_ID, admin: ADMIN, fee: 100, timeframe: 60_000, token: 'T', developer: ADMIN}),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc.invalid']})
    }
})

afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
})

/**
 * Starts one worker call whose pre-build read never settles and drives the clock across the 20 s budget
 * @param {object} runner - runner with __buildAndSubmitTransaction stubbed
 * @param {number} [timestamp] - tick to run
 * @returns {Promise<string[]>} the outcome just before the budget runs out and just after
 */
async function outcomeAroundBudget(runner, timestamp = TICK) {
    let outcome = 'pending'
    runner.__workerFn(timestamp).then(() => {
        outcome = 'resolved'
    }, e => {
        outcome = e.message
    })
    await jest.advanceTimersByTimeAsync(19_999)
    const before = outcome
    await jest.advanceTimersByTimeAsync(2)
    return [before, outcome]
}

describe('a pre-build read that never answers ends the worker at the budget', () => {
    test('OracleRunner, getOracleContractState hanging', async () => {
        getAccount.mockResolvedValue(account)
        getOracleContractState.mockImplementation(hang)
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
        runner.__buildAndSubmitTransaction = jest.fn()
        expect(await outcomeAroundBudget(runner)).toEqual(['pending', 'Pre-build contract reads timed out.'])
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })

    test('ClusterRunner, getAccount hanging', async () => {
        getAccount.mockImplementation(hang)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn()
        expect(await outcomeAroundBudget(runner)).toEqual(['pending', 'Pre-build contract reads timed out.'])
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })

    test('DAORunner, getContractState hanging after getAccount answered', async () => {
        getAccount.mockResolvedValue(account)
        getContractState.mockImplementation(hang)
        const runner = new DAORunner(CONTRACT_ID)
        runner.__buildAndSubmitTransaction = jest.fn()
        expect(await outcomeAroundBudget(runner)).toEqual(['pending', 'Pre-build contract reads timed out.'])
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })

    test('SubscriptionsRunner, getContractState hanging after getAccount answered', async () => {
        getAccount.mockResolvedValue(account)
        getContractState.mockImplementation(hang)
        const runner = Object.create(SubscriptionsRunner.prototype)
        runner.contractId = CONTRACT_ID
        runner.__buildAndSubmitTransaction = jest.fn()
        expect(await outcomeAroundBudget(runner)).toEqual(['pending', 'Pre-build contract reads timed out.'])
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })

    test('SubscriptionsRunner, the subscription event reads hanging after the contract reads answered', async () => {
        getAccount.mockResolvedValue(account)
        getContractState.mockResolvedValue({isInitialized: true, lastSubscriptionsId: 0n})
        getManager.mockReturnValue({lastSyncData: null})
        const runner = Object.create(SubscriptionsRunner.prototype)
        runner.contractId = CONTRACT_ID
        //the processor hands its reads to the bound it is given, as processLastEvents does
        runner.__subscriptionsProcessor = {getSubscriptionActions: jest.fn((timestamp, bound) => bound(hang()))}
        runner.__buildAndSubmitTransaction = jest.fn()
        expect(await outcomeAroundBudget(runner)).toEqual(['pending', 'Subscription events load timed out.'])
        expect(runner.__subscriptionsProcessor.getSubscriptionActions).toHaveBeenCalledWith(TICK, expect.any(Function))
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })
})

describe('a timed-out cluster switch read abstains; it never switches on partial data', () => {
    test('the timed-out tick neither builds nor applies the pending update, even when the read answers late', async () => {
        let answer
        getAccount.mockImplementation(() => new Promise(resolve => {
            answer = resolve
        }))
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve())
        expect(await outcomeAroundBudget(runner)).toEqual(['pending', 'Pre-build contract reads timed out.'])

        //the read answers after the budget: the worker has already ended, so nothing is built from it
        answer(account)
        await jest.advanceTimersByTimeAsync(1000)

        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(container.settingsManager.applyPendingUpdate).not.toHaveBeenCalled()
        expect(nodesManager.broadcast).not.toHaveBeenCalled()
    })

    test('the next tick whose read answers builds the update and applies it', async () => {
        getAccount.mockImplementationOnce(hang)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve())
        expect(await outcomeAroundBudget(runner)).toEqual(['pending', 'Pre-build contract reads timed out.'])

        getAccount.mockResolvedValueOnce(account)
        await expect(runner.__workerFn(TICK + 120_000)).resolves.toBe(true)

        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        const [, sourceAccount, fee, syncTimestamp] = runner.__buildAndSubmitTransaction.mock.calls[0]
        expect(sourceAccount).toBe(account)
        expect(fee).toBe(10000000)
        //the pending update is past its switch time, so the tick itself is the sync timestamp, as on every other node
        expect(syncTimestamp).toBe(TICK + 120_000)
        expect(container.settingsManager.applyPendingUpdate).toHaveBeenCalledTimes(1)
    })
})

describe('a transaction build that never settles ends at the build deadline', () => {
    /**
     * @returns {DAORunner} a running runner whose real __buildAndSubmitTransaction is under test
     */
    function makeRunner() {
        const runner = new DAORunner(CONTRACT_ID)
        runner.isRunning = true
        return runner
    }

    test('every attempt ends after 15 s, is logged as one line, and nothing is signed or broadcast', async () => {
        jest.setSystemTime(TICK)
        logger.error.mockClear()
        const build = jest.fn(hang)
        let outcome = 'pending'
        makeRunner().__buildAndSubmitTransaction(build, account, 100, TICK).catch(e => {
            outcome = e.message
        })
        await jest.advanceTimersByTimeAsync(14_999)
        expect(build).toHaveBeenCalledTimes(1)
        await jest.advanceTimersByTimeAsync(2)
        expect(build).toHaveBeenCalledTimes(2) //attempt 1 gave up at 15 s and attempt 2 started
        await jest.advanceTimersByTimeAsync(15_001)
        expect(build).toHaveBeenCalledTimes(2)
        expect(outcome).toBe('Failed to submit transaction. See logs for details.')
        //an expired deadline reads as a timeout: one line per attempt, not a full error object
        expect(logger.error.mock.calls).toEqual([['Transaction build timed out.'], ['Transaction build timed out.']])
        expect(nodesManager.broadcast).not.toHaveBeenCalled()
    })

    test('the build deadline never outlasts what is left of the attempt envelope', async () => {
        //attempt 1's envelope ends 40 s after the sync timestamp, so 35 s in only 5 s of it is left
        jest.setSystemTime(TICK + 35_000)
        const build = jest.fn(hang)
        makeRunner().__buildAndSubmitTransaction(build, account, 100, TICK).catch(() => {})
        await jest.advanceTimersByTimeAsync(4_999)
        expect(build).toHaveBeenCalledTimes(1)
        await jest.advanceTimersByTimeAsync(2)
        expect(build).toHaveBeenCalledTimes(2)
        //the retry pays 8x, so the second call is attempt 2, not a repeat of attempt 1
        expect(build.mock.calls.map(([, fee]) => fee)).toEqual([100, 800])
    })

    test('an attempt that builds nothing never returns the response an earlier attempt left behind (N-4)', async () => {
        jest.setSystemTime(TICK)
        const runner = makeRunner()
        runner.__trySubmitTransaction = jest.fn()
        //attempt 0 lands, then fails on its own bookkeeping: the landed envelope does not parse
        runner.__setPendingTransaction = jest.fn(() => ({submitPromise: Promise.resolve({envelopeXdr: 'not an envelope'})}))
        const built = {type: 'test', hashHex: 'a', transaction: {toXdr: () => 'a'}}
        const build = jest.fn()
            .mockResolvedValueOnce(built)
            .mockResolvedValueOnce(null) //attempt 1: nothing left to submit

        await expect(runner.__buildAndSubmitTransaction(build, account, 100, TICK)).resolves.toEqual({response: null, tx: null})
        expect(build).toHaveBeenCalledTimes(2)
    })
})
