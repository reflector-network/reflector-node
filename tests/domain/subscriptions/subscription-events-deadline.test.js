/*eslint-disable no-undef */
jest.mock('../../../src/domain/container', () => ({
    validSymbols: {src: '*'},
    settingsManager: {
        clusterSecretObject: null,
        getBlockchainConnectorSettings: () => ({sorobanRpc: ['rpc']})
    }
}))
jest.mock('../../../src/domain/data-sources-manager', () => ({
    has: jest.fn(() => true),
    isStellarSource: jest.fn(() => false)
}))
jest.mock('../../../src/utils/rpc-helper', () => ({
    getLastContractEvents: jest.fn(),
    getEventsLedgerInfo: jest.fn()
}))
jest.mock('../../../src/utils/crypto-helper', () => ({decrypt: jest.fn()}))
jest.mock('../../../src/utils/ssrf-validator', () => ({validateWebhookUrl: jest.fn()}))
jest.mock('@reflector/reflector-shared', () => ({
    getSubscriptions: jest.fn(),
    getSubscriptionsContractState: jest.fn(),
    Asset: jest.fn().mockImplementation((type, code) => ({type, code, isContractId: false})),
    AssetType: {STELLAR: 'stellar', OTHER: 'other'},
    compareStrings: (a, b) => (a < b ? -1 : (a > b ? 1 : 0))
}))
//identity scValToNative, so plain event topics and values flow through unchanged
jest.mock('@stellar/stellar-sdk', () => ({scValToNative: v => v}))

const shared = require('@reflector/reflector-shared')
const {getLastContractEvents, getEventsLedgerInfo} = require('../../../src/utils/rpc-helper')
const {withDeadline} = require('../../../src/utils/utils')
const {SubscriptionContractManager} = require('../../../src/domain/subscriptions/subscriptions-data-manager')

const budget = reads => withDeadline(reads, 20_000, 'Subscription events load timed out.')

/**
 * @param {bigint} id - subscription id
 * @returns {object} an active subscription as the contract stores it
 */
function rawSubscription(id) {
    return {id, status: 0, balance: 1000n, updated: 1n, owner: 'owner', threshold: 50, heartbeat: 10, webhook: null, base: {source: 'src', asset: 'BTC'}, quote: {source: 'src', asset: 'USD'}}
}

/**
 * @returns {{promise: Promise<any>, answer: Function}} a read that answers only when the test says so
 */
function heldRead() {
    let answer
    const promise = new Promise(resolve => {
        answer = resolve
    })
    return {promise, answer}
}

beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    shared.getSubscriptionsContractState.mockResolvedValue({lastSubscriptionId: 2n})
    shared.getSubscriptions.mockResolvedValue([rawSubscription(1n), rawSubscription(2n)])
})

afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
})

describe('subscription event reads under a budget cannot write state after it runs out', () => {
    test('an in-range events read that answers after the budget changes neither the ledger nor the subscriptions', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(10n, {id: 10n, webhook: []})
        getEventsLedgerInfo.mockResolvedValue({oldestLedger: 0, latestLedger: 1000})
        const read = heldRead()
        getLastContractEvents.mockReturnValue(read.promise)

        const run = mgr.processLastEvents(budget)
        const outcome = expect(run).rejects.toThrow('Subscription events load timed out.')
        await jest.advanceTimersByTimeAsync(20_001)
        await outcome

        //the read answers late with an event that would delete subscription 10 and move the ledger on
        read.answer({events: [{topic: ['contract', 'suspended'], value: [10n], timestamp: 1}], lastLedger: 777})
        await jest.advanceTimersByTimeAsync(1000)

        expect(mgr.__lastLedger).toBe(500)
        expect([...mgr.__subscriptions.keys()]).toEqual([10n])
    })

    test('reads that answer inside the budget are applied as before', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 50
        mgr.__subscriptions.set(999n, {id: 999n, webhook: []})
        getEventsLedgerInfo.mockResolvedValue({oldestLedger: 60, latestLedger: 1000})
        getLastContractEvents.mockResolvedValue({events: [{topic: ['contract', 'suspended'], value: [2n], timestamp: 1}], lastLedger: 777})

        await expect(mgr.processLastEvents(budget)).resolves.toBe(true) //a full reload

        expect(getLastContractEvents).toHaveBeenCalledWith('c1', 640, ['rpc'])
        expect([...mgr.__subscriptions.keys()]).toEqual([1n])
        expect(mgr.__lastLedger).toBe(777)
        expect(mgr.__isInitialized).toBe(true)
    })

    test('an in-range tick reports that it made no reload', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        getEventsLedgerInfo.mockResolvedValue({oldestLedger: 0, latestLedger: 1000})
        getLastContractEvents.mockResolvedValue({events: [], lastLedger: 600})

        await expect(mgr.processLastEvents(budget)).resolves.toBe(false)
        expect(shared.getSubscriptions).not.toHaveBeenCalled()
        expect(mgr.__lastLedger).toBe(600)
    })

    test('the range check that decides on a reload is still cut off at the budget', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        getEventsLedgerInfo.mockReturnValue(new Promise(() => {}))

        const run = mgr.processLastEvents(budget)
        const outcome = expect(run).rejects.toThrow('Subscription events load timed out.')
        await jest.advanceTimersByTimeAsync(20_001)
        await outcome
        expect(shared.getSubscriptions).not.toHaveBeenCalled()
        expect(mgr.__lastLedger).toBe(500)
    })
})

describe('a full subscriptions reload is exempt from the tick budget and applies all at once, or not at all [N-1]', () => {
    /**
     * @param {number} delay - milliseconds before the subscription batches answer
     * @param {any} [outcome] - an Error to fail the batches with, or the raw subscriptions to answer
     */
    function slowSubscriptions(delay, outcome = [rawSubscription(1n), rawSubscription(2n)]) {
        shared.getSubscriptions.mockImplementation(() => new Promise((resolve, reject) => setTimeout(() => {
            if (outcome instanceof Error)
                reject(outcome)
            else
                resolve(outcome)
        }, delay)))
    }

    /**
     * @returns {SubscriptionContractManager} a manager that just booted: no ledger cursor yet, one stale entry
     */
    function bootedManager() {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__subscriptions.set(999n, {id: 999n, webhook: []})
        getEventsLedgerInfo.mockResolvedValue({oldestLedger: 60, latestLedger: 1000}) //60 > null: out of range
        return mgr
    }

    test('a reload slower than the budget completes and is applied exactly once', async () => {
        const mgr = bootedManager()
        slowSubscriptions(45_000) //more than twice the 20 s budget
        getLastContractEvents.mockResolvedValue({events: [{topic: ['contract', 'suspended'], value: [2n], timestamp: 1}], lastLedger: 777})

        let outcome = 'pending'
        mgr.processLastEvents(budget).then(v => {
            outcome = v
        }, e => {
            outcome = e.message
        })
        await jest.advanceTimersByTimeAsync(20_001)
        expect(outcome).toBe('pending') //not cut off by the budget
        //nothing is applied while the reload is still reading
        expect([...mgr.__subscriptions.keys()]).toEqual([999n])
        expect(mgr.__lastLedger).toBe(null)

        await jest.advanceTimersByTimeAsync(25_000)
        expect(outcome).toBe(true)
        expect(shared.getSubscriptions).toHaveBeenCalledTimes(1)
        expect(getLastContractEvents).toHaveBeenCalledWith('c1', 640, ['rpc'])
        //the reloaded set, with the events since the reload's start applied on top, and the cursor with it
        expect([...mgr.__subscriptions.keys()]).toEqual([1n])
        expect(mgr.__lastLedger).toBe(777)
        expect(mgr.__isInitialized).toBe(true)
    })

    test.each([
        ['a subscription batch fails', () => slowSubscriptions(30_000, new Error('batch 3 failed')), 'batch 3 failed'],
        ['the events read after the batches fails', () => {
            slowSubscriptions(30_000)
            getLastContractEvents.mockRejectedValue(new Error('events failed'))
        }, 'events failed']
    ])('a reload that fails partway (%s) applies nothing', async (label, arrange, message) => {
        const mgr = bootedManager()
        arrange()

        const run = mgr.processLastEvents(budget)
        const outcome = expect(run).rejects.toThrow(message)
        await jest.advanceTimersByTimeAsync(30_001)
        await outcome

        expect([...mgr.__subscriptions.keys()]).toEqual([999n])
        expect(mgr.__lastLedger).toBe(null)
        expect(mgr.__isInitialized).toBe(false)
    })
})
