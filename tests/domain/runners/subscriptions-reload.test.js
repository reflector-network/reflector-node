/*eslint-disable no-undef */
jest.mock('../../../src/domain/container', () => ({settingsManager: null, validSymbols: {src: '*'}}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(() => Promise.resolve()), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({
    setLastProcessedTimestamp: jest.fn(),
    setLastSubscriptionData: jest.fn(),
    setSubscriptionTriggerTimestamp: jest.fn()
}))
jest.mock('../../../src/domain/data-sources-manager', () => ({
    has: jest.fn(() => true),
    isStellarSource: jest.fn(() => false)
}))
jest.mock('../../../src/domain/prices/price-manager', () => ({
    getPricesForPair: jest.fn(() => Promise.resolve({price: 100n, decimals: 7}))
}))
//the node's rpc reads; the runner, the processor and the subscriptions manager all run for real on top of them
jest.mock('../../../src/utils/rpc-helper', () => ({
    getEventsLedgerInfo: jest.fn(),
    getLastContractEvents: jest.fn(),
    getAccount: jest.fn(),
    submitTransaction: jest.fn(),
    makeServerRequest: jest.fn(),
    txTimeoutMessage: 'Tx timed out.'
}))
jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared'),
    getContractState: jest.fn(),
    getSubscriptions: jest.fn(),
    getSubscriptionsContractState: jest.fn()
}))

const {Keypair} = require('@stellar/stellar-sdk')
const shared = require('@reflector/reflector-shared')
const {getEventsLedgerInfo, getLastContractEvents, getAccount} = require('../../../src/utils/rpc-helper')
const {getPricesForPair} = require('../../../src/domain/prices/price-manager')
const container = require('../../../src/domain/container')
const {getManager} = require('../../../src/domain/subscriptions/subscriptions-data-manager')
const SubscriptionsRunner = require('../../../src/domain/runners/subscriptions-runner')
const {roundSyncDelay} = require('../../../src/domain/sync-delays')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const TICK = 1_700_000_100_000 //a whole minute
const DELAY = roundSyncDelay //the subscriptions round starts with the oracle's
const CREATED_AT = 1_700_000_171 //seconds, as the rpc reports a landed transaction
const runners = []

/**
 * @param {bigint} id - subscription id
 * @returns {object} an active subscription as the contract stores it: due for a charge and for a heartbeat trigger
 */
function rawSubscription(id) {
    return {id, status: 0, balance: 1000n, updated: 1n, owner: 'owner', threshold: 50, heartbeat: 10, webhook: null, base: {source: 'src', asset: 'BTC'}, quote: {source: 'src', asset: 'USD'}}
}

/**
 * @returns {SubscriptionsRunner} a running runner whose builds are recorded and land at once
 */
function makeRunner() {
    const runner = new SubscriptionsRunner(CONTRACT_ID)
    runner.isRunning = true
    runner.__processTriggerData = jest.fn() //webhook delivery is out of scope here
    runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve({response: {createdAt: CREATED_AT}, tx: {}}))
    runners.push(runner)
    return runner
}

/**
 * @param {SubscriptionsRunner} runner - runner under test
 * @param {number} tick - tick timestamp
 * @returns {{outcome: any}} live view of how the worker call ends
 */
function startWorker(runner, tick) {
    const view = {outcome: 'pending'}
    runner.__workerFn(tick).then(v => {
        view.outcome = v
    }, e => {
        view.outcome = e.message
    })
    return view
}

/**
 * Lets a worker that waits only on webcrypto, not on timers, run to its end. The hash computation goes through the
 * libuv thread pool, whose real duration depends on system load, so a real wall-clock budget - not a fixed turn
 * count - decides when to give up. setTimeout is faked in this suite, so the budget is armed through the real,
 * unpatched timers module
 * @param {{outcome: any}} view - live view from startWorker
 * @returns {Promise<void>}
 */
async function settle(view) {
    const {setTimeout: realSetTimeout, clearTimeout: realClearTimeout} = jest.requireActual('timers')
    let timedOut = false
    const budget = realSetTimeout(() => {
        timedOut = true
    }, 5000)
    while (view.outcome === 'pending' && !timedOut)
        await new Promise(resolve => setImmediate(resolve))
    realClearTimeout(budget)
}

beforeEach(() => {
    //setImmediate stays real: the trigger hashes go through webcrypto, which settles off the timer queue
    jest.useFakeTimers({now: TICK + DELAY, doNotFake: ['setImmediate']})
    jest.clearAllMocks()
    const keypair = Keypair.random()
    container.settingsManager = {
        appConfig: {keypair, publicKey: keypair.publicKey(), dbSyncDelay: 3000},
        config: {nodes: new Map([[keypair.publicKey(), {pubkey: keypair.publicKey()}]])},
        clusterSecretObject: null,
        getContractConfig: () => ({contractId: CONTRACT_ID, admin: keypair.publicKey(), fee: 100}),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc.invalid']})
    }
    getAccount.mockResolvedValue({accountId: () => 'G', sequenceNumber: () => '1', incrementSequenceNumber: jest.fn()})
    shared.getContractState.mockResolvedValue({isInitialized: true, lastSubscriptionsId: 2n})
    shared.getSubscriptionsContractState.mockResolvedValue({lastSubscriptionId: 2n})
    //the full reload's batches answer after 45 s, more than twice the 20 s tick budget
    const reloaded = [rawSubscription(1n), rawSubscription(2n)]
    shared.getSubscriptions.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(reloaded), 45_000)))
    //a booted node has no ledger cursor, so its first tick is out of range and reloads
    getEventsLedgerInfo.mockResolvedValue({oldestLedger: 60, latestLedger: 1000})
    getLastContractEvents.mockResolvedValue({events: [], lastLedger: 777})
})

afterEach(() => {
    for (const runner of runners.splice(0))
        runner.stop()
    jest.clearAllTimers()
    jest.useRealTimers()
})

describe('the first tick after boot reloads every subscription past the tick budget and builds nothing [N-1]', () => {
    test('a reload slower than 20 s completes once, the reload tick abstains, and the next tick triggers and charges', async () => {
        const runner = makeRunner()

        const reloadTick = startWorker(runner, TICK)
        await jest.advanceTimersByTimeAsync(20_001)
        expect(reloadTick.outcome).toBe('pending') //the reload is not cut off by the 20 s budget
        await jest.advanceTimersByTimeAsync(25_000)
        expect(reloadTick.outcome).toBe(false)
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(getPricesForPair).not.toHaveBeenCalled()
        const manager = getManager(CONTRACT_ID)
        expect(manager.subscriptions.map(s => s.id)).toEqual([1n, 2n])
        expect(manager.__lastLedger).toBe(777)

        //the next tick is in range: the incremental read, then a heartbeat trigger for both and a charge for both
        jest.setSystemTime(TICK + 60_000 + DELAY)
        getLastContractEvents.mockResolvedValue({events: [], lastLedger: 800})
        const nextTick = startWorker(runner, TICK + 60_000)
        await jest.advanceTimersByTimeAsync(100)
        await settle(nextTick)

        expect(nextTick.outcome).toBe(true)
        expect(shared.getSubscriptions).toHaveBeenCalledTimes(1) //the reload ran exactly once
        expect(manager.__lastLedger).toBe(800)
        const calls = runner.__buildAndSubmitTransaction.mock.calls
        expect(calls).toHaveLength(2)
        //the trigger, on the tick's own envelope
        expect(calls[0].slice(2)).toEqual([100, TICK + 60_000, DELAY])
        //the charge, on an envelope taken from the landed trigger's response (N-3)
        expect(calls[1].slice(2)).toEqual([100, shared.normalizeTimestamp(CREATED_AT * 1000 + 5000 - 1, 5000), 0])
    }, 10_000) //settle()'s own real-time budget is 5 s; this leaves headroom above Jest's default test timeout

    test('a ten-minute reload resumes at the latest started tick instead of replaying the ones it missed', async () => {
        shared.getSubscriptions.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([rawSubscription(1n)]), 630_000)))
        const runner = makeRunner()
        runner.__runWorker = jest.fn() //records what the worker schedules next, without running it

        const reloadTick = runner.worker(TICK)
        await jest.advanceTimersByTimeAsync(631_000)
        await reloadTick

        //no other tick of this runner ran while the reload did: the next one is armed only once the worker ends
        expect(runner.__runWorker.mock.calls).toEqual([[TICK + 600_000]])
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })

    test('a normal tick\'s incremental read is still cut off at 20 s, through the real processor', async () => {
        const runner = makeRunner()
        getManager(CONTRACT_ID).__lastLedger = 500 //already initialised: in range
        getEventsLedgerInfo.mockResolvedValue({oldestLedger: 0, latestLedger: 1000})
        getLastContractEvents.mockReturnValue(new Promise(() => {}))

        const tick = startWorker(runner, TICK)
        await jest.advanceTimersByTimeAsync(19_999)
        expect(tick.outcome).toBe('pending')
        await jest.advanceTimersByTimeAsync(2)
        expect(tick.outcome).toBe('Subscription events load timed out.')
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(getManager(CONTRACT_ID).__lastLedger).toBe(500)
    })
})

describe('SubscriptionsRunner scheduling [N-1]', () => {
    test.each([
        ['a worker that ended on time', TICK + DELAY + 5_000, TICK + 60_000],
        ['a worker that overran by less than a timeframe', TICK + 60_000 + DELAY + 20_000, TICK + 60_000],
        ['a worker that overran by ten minutes', TICK + 600_000 + DELAY + 30_000, TICK + 600_000]
    ])('%s', (label, now, next) => {
        jest.setSystemTime(now)
        expect(makeRunner().__getNextTimestamp(TICK)).toBe(next)
    })
})
