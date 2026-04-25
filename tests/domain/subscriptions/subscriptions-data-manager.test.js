/*eslint-disable no-undef */
/*
 * Unit tests for SubscriptionContractManager and module-level helpers.
 *
 * Several getWebhook / __ensureWebhooksDecrypted tests pin the INTENDED
 * behavior of the recent refactor and currently fail against the live source
 * because the guard at src/domain/subscriptions/subscriptions-data-manager.js:89
 * is inverted (reads `if (clusterSecretObject) return null` — should read
 * `if (!clusterSecretObject) return null`). Each such test is tagged inline.
 */

jest.mock('../../../src/domain/container', () => ({
    validSymbols: {src: '*', strict: ['USD', 'EUR']},
    settingsManager: {
        clusterSecretObject: null,
        getBlockchainConnectorSettings: jest.fn(() => ({sorobanRpc: ['rpc']}))
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
    AssetType: {STELLAR: 'stellar', OTHER: 'other'}
}))

//Identity-map scValToNative so our plain-JS event topics/values flow through unchanged.
jest.mock('@stellar/stellar-sdk', () => ({scValToNative: (v) => v}))

jest.mock('../../../src/domain/subscriptions/subscriptions-sync-data', () =>
    jest.fn().mockImplementation(data => ({
        __data: data,
        timestamp: data?.timestamp ?? 0,
        isVerified: true,
        hashBase64: `hash-${data?.timestamp ?? 'x'}`,
        __signatures: [],
        calculateHash: jest.fn().mockResolvedValue(undefined),
        tryAddSignature: jest.fn(),
        merge: jest.fn()
    }))
)

const shared = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const dataSourcesManager = require('../../../src/domain/data-sources-manager')
const {getLastContractEvents, getEventsLedgerInfo} = require('../../../src/utils/rpc-helper')
const {decrypt} = require('../../../src/utils/crypto-helper')
const {validateWebhookUrl} = require('../../../src/utils/ssrf-validator')
const SubscriptionsSyncData = require('../../../src/domain/subscriptions/subscriptions-sync-data')
const {
    SubscriptionContractManager,
    addManager,
    getManager,
    removeManager,
    getAllSubscriptions
} = require('../../../src/domain/subscriptions/subscriptions-data-manager')

//`getWebhook` is not exported; reach it through __setSubscription side effects,
//which invoke it exactly once per raw subscription.
async function decryptThrough(manager, webhookBuffer) {
    const raw = makeRawSubscription({id: 1n, webhook: webhookBuffer})
    await manager.__setSubscription(raw)
    const stored = manager.__subscriptions.get(1n)
    return stored ? stored.webhook : undefined
}

function makeRawSubscription(overrides = {}) {
    return {
        id: 1n,
        status: 0,
        balance: 1000n,
        updated: 1_700_000n,
        owner: 'owner-pk',
        threshold: 50,
        heartbeat: 10,
        webhook: Buffer.from([1, 2, 3]),
        base: {source: 'src', asset: 'BTC'},
        quote: {source: 'src', asset: 'USD'},
        ...overrides
    }
}

beforeEach(() => {
    //resetAllMocks clears call history AND resets implementations, so a mockResolvedValue
    //set by one test doesn't leak into the next. We re-apply baselines below.
    jest.resetAllMocks()
    container.settingsManager.clusterSecretObject = null
    container.settingsManager.getBlockchainConnectorSettings.mockImplementation(() => ({sorobanRpc: ['rpc']}))
    dataSourcesManager.has.mockImplementation(() => true)
    dataSourcesManager.isStellarSource.mockImplementation(() => false)
    getEventsLedgerInfo.mockResolvedValue({oldestLedger: 0, latestLedger: 100})
    getLastContractEvents.mockResolvedValue({events: [], lastLedger: 100})
    shared.getSubscriptions.mockResolvedValue([])
    shared.getSubscriptionsContractState.mockResolvedValue({lastSubscriptionId: 0n})
    shared.Asset.mockImplementation((type, code) => ({type, code, isContractId: false}))
    validateWebhookUrl.mockImplementation(() => undefined) //no-op by default
    SubscriptionsSyncData.mockImplementation(data => ({
        __data: data,
        timestamp: data?.timestamp ?? 0,
        isVerified: true,
        hashBase64: `hash-${data?.timestamp ?? 'x'}`,
        __signatures: [],
        calculateHash: jest.fn().mockResolvedValue(undefined),
        tryAddSignature: jest.fn(),
        merge: jest.fn()
    }))
})

describe('getWebhook (exercised via __setSubscription)', () => {
    test('key missing + non-empty buffer → returns null (defer)', async () => {
        container.settingsManager.clusterSecretObject = null
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([9, 9, 9]))
        expect(webhook).toBeNull()
        expect(decrypt).not.toHaveBeenCalled()
    })

    test('key missing + empty buffer → returns null (defer regardless of buffer)', async () => {
        //Under the flipped guard, an empty buffer still defers when the key is missing — simpler than
        //reordering the checks, and harmless because __ensureWebhooksDecrypted will resolve it to []
        //on the next pass once the key lands.
        container.settingsManager.clusterSecretObject = null
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.alloc(0))
        expect(webhook).toBeNull()
    })

    test('key present + decrypt returns JSON array → returns parsed array', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode('[{"url":"https://a.example"}]'))
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([1]))
        expect(webhook).toEqual([{url: 'https://a.example'}])
    })

    test('key present + decrypt returns comma-joined URL list → array of {url}', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode('https://a.example,https://b.example'))
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([1]))
        expect(webhook).toEqual([
            {url: 'https://a.example'},
            {url: 'https://b.example'}
        ])
    })

    test('key present + validateWebhookUrl rejects one URL → keeps the rest', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode('https://good.example,bad-scheme://x'))
        validateWebhookUrl.mockImplementation((url) => {
            if (!url.startsWith('https://'))
                throw new Error('blocked scheme')
        })
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([1]))
        expect(webhook).toEqual([{url: 'https://good.example'}])
    })

    test('key present + decrypt returns null → returns null', async () => {
        //Passes pre-flip via the short-circuit at line 89 and post-flip via the explicit `if (!decrypted)`
        //guard; kept as a regression guard on the decrypt-null handling path.
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(null)
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([1]))
        expect(webhook).toBeNull()
    })

    test('key present + decrypt returns empty bytes → returns null', async () => {
        //Same both-ways-green property as the decrypt-null test above; locks the empty-string handling.
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new Uint8Array(0))
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([1]))
        expect(webhook).toBeNull()
    })

    test('key present + decrypt throws → caught, returns []', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockRejectedValue(new Error('boom'))
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([1]))
        expect(webhook).toEqual([])
    })

    test('key present + decrypted JSON not an array → caught, returns []', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode('[{}'))  //parse error → caught
        const mgr = new SubscriptionContractManager('c1')
        const webhook = await decryptThrough(mgr, Buffer.from([1]))
        expect(webhook).toEqual([])
    })
})

describe('SubscriptionContractManager constructor', () => {
    test('throws when contractId is missing', () => {
        expect(() => new SubscriptionContractManager()).toThrow('Contract id is required')
        expect(() => new SubscriptionContractManager('')).toThrow('Contract id is required')
    })

    test('stores the contract id when provided', () => {
        const mgr = new SubscriptionContractManager('C123')
        expect(mgr.contractId).toBe('C123')
    })
})

describe('__setSubscription', () => {
    test('null raw → no-op', async () => {
        const mgr = new SubscriptionContractManager('c1')
        await mgr.__setSubscription(null)
        expect(mgr.__subscriptions.size).toBe(0)
    })

    test('inactive (status !== 0) → skipped', async () => {
        const mgr = new SubscriptionContractManager('c1')
        await mgr.__setSubscription(makeRawSubscription({status: 1}))
        expect(mgr.__subscriptions.size).toBe(0)
    })

    test('asset with isContractId=true → passes', async () => {
        shared.Asset.mockImplementationOnce((type, code) => ({type, code, isContractId: true}))
        const mgr = new SubscriptionContractManager('c1')
        await mgr.__setSubscription(makeRawSubscription())
        expect(mgr.__subscriptions.size).toBe(1)
    })

    test('symbol not in allowlist → skipped', async () => {
        const mgr = new SubscriptionContractManager('c1')
        await mgr.__setSubscription(makeRawSubscription({
            base: {source: 'strict', asset: 'BTC'},  //strict allowlist is USD/EUR only
            quote: {source: 'strict', asset: 'USD'}
        }))
        expect(mgr.__subscriptions.size).toBe(0)
    })

    test('source not registered → skipped', async () => {
        dataSourcesManager.has.mockImplementation(() => false)
        const mgr = new SubscriptionContractManager('c1')
        await mgr.__setSubscription(makeRawSubscription())
        expect(mgr.__subscriptions.size).toBe(0)
    })

    test('happy path → subscription stored with rawWebhook field', async () => {
        //Structural assertions (rawWebhook storage) still pass; only the decrypted webhook array depends on the flip.
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode('https://a.example'))
        const mgr = new SubscriptionContractManager('c1')
        const rawBuf = Buffer.from([7, 7])
        const raw = makeRawSubscription({id: 42n, updated: 1_700_000n, webhook: rawBuf})
        await mgr.__setSubscription(raw)
        const stored = mgr.__subscriptions.get(42n)
        expect(stored).toBeDefined()
        expect(stored.id).toBe(42n)
        expect(stored.balance).toBe(raw.balance)
        expect(stored.status).toBe(0)
        expect(stored.threshold).toBe(50)
        expect(stored.heartbeat).toBe(10)
        expect(stored.lastCharge).toBe(Number(1_700_000n))
        expect(stored.rawWebhook).toBe(rawBuf)  //new field from the recent diff
        expect(stored.webhook).toEqual([{url: 'https://a.example'}])
    })

    test('stores rawWebhook even when webhook decryption defers (null)', async () => {
        container.settingsManager.clusterSecretObject = null
        const mgr = new SubscriptionContractManager('c1')
        const rawBuf = Buffer.from([3, 3])
        const raw = makeRawSubscription({id: 5n, webhook: rawBuf})
        await mgr.__setSubscription(raw)
        const stored = mgr.__subscriptions.get(5n)
        expect(stored).toBeDefined()
        expect(stored.rawWebhook).toBe(rawBuf)
        expect(stored.webhook).toBeNull()
    })

    test('throw inside getNormalizedAsset → caught, map unchanged', async () => {
        const mgr = new SubscriptionContractManager('c1')
        //asset is a non-String (constructor.name !== 'String') → throws
        await mgr.__setSubscription(makeRawSubscription({
            base: {source: 'src', asset: 42}
        }))
        expect(mgr.__subscriptions.size).toBe(0)
    })
})

describe('__ensureWebhooksDecrypted', () => {
    function seed(mgr, entries) {
        for (const [id, data] of entries)
            mgr.__subscriptions.set(id, data)
    }

    test('already-decrypted subscriptions are skipped (decrypt not called)', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        const mgr = new SubscriptionContractManager('c1')
        seed(mgr, [
            [1n, {webhook: [{url: 'https://a'}], rawWebhook: Buffer.from([1])}],
            [2n, {webhook: [], rawWebhook: Buffer.alloc(0)}]  //empty array is still decrypted (non-null)
        ])
        await mgr.__ensureWebhooksDecrypted()
        expect(decrypt).not.toHaveBeenCalled()
    })

    test('null webhook + key available → decrypted and promoted', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode('https://a.example'))
        const mgr = new SubscriptionContractManager('c1')
        const rawBuf = Buffer.from([8, 8])
        seed(mgr, [[7n, {webhook: null, rawWebhook: rawBuf}]])
        await mgr.__ensureWebhooksDecrypted()
        const sub = mgr.__subscriptions.get(7n)
        expect(sub.webhook).toEqual([{url: 'https://a.example'}])
    })

    test('null webhook + key still missing → stays null', async () => {
        container.settingsManager.clusterSecretObject = null
        const mgr = new SubscriptionContractManager('c1')
        seed(mgr, [[7n, {webhook: null, rawWebhook: Buffer.from([9])}]])
        await mgr.__ensureWebhooksDecrypted()
        expect(mgr.__subscriptions.get(7n).webhook).toBeNull()
        expect(decrypt).not.toHaveBeenCalled()
    })

    test('mixed set → only null entries are retried', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode('https://new.example'))
        const mgr = new SubscriptionContractManager('c1')
        const existing = [{url: 'https://keep.example'}]
        seed(mgr, [
            [1n, {webhook: existing, rawWebhook: Buffer.from([1])}],
            [2n, {webhook: null, rawWebhook: Buffer.from([2])}]
        ])
        await mgr.__ensureWebhooksDecrypted()
        expect(mgr.__subscriptions.get(1n).webhook).toBe(existing)   //untouched
        expect(mgr.__subscriptions.get(2n).webhook).toEqual([{url: 'https://new.example'}])
        expect(decrypt).toHaveBeenCalledTimes(1)
    })
})

describe('processLastEvents', () => {
    function makeEvent(topic, value, timestamp = 1) {
        return {topic, value, timestamp}
    }

    test('out-of-range → clears map, loads subscriptions, start ledger is latestLedger - 360', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__subscriptions.set(999n, {webhook: [], rawWebhook: Buffer.alloc(0)})
        mgr.__lastLedger = 50   //oldestLedger (say 60) > __lastLedger → out-of-range
        getEventsLedgerInfo.mockResolvedValue({oldestLedger: 60, latestLedger: 1000})
        await mgr.processLastEvents()
        expect(shared.getSubscriptions).toHaveBeenCalled()
        expect(shared.getSubscriptionsContractState).toHaveBeenCalled()
        //Legacy entry must have been cleared before the reload.
        expect(mgr.__subscriptions.has(999n)).toBe(false)
        //Start ledger is latestLedger - 360 = 640.
        expect(getLastContractEvents).toHaveBeenCalledWith('c1', 640, ['rpc'])
    })

    test('in-range → no reload, start ledger is __lastLedger', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500  //> oldestLedger (0)
        await mgr.processLastEvents()
        expect(shared.getSubscriptions).not.toHaveBeenCalled()
        expect(getLastContractEvents).toHaveBeenCalledWith('c1', 500, ['rpc'])
    })

    test('empty event list still updates __lastLedger from RPC response', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        getLastContractEvents.mockResolvedValue({events: [], lastLedger: 777})
        await mgr.processLastEvents()
        expect(mgr.__lastLedger).toBe(777)
    })

    test('created event → subscription added with id merged into rawSubscription', async () => {
        container.settingsManager.clusterSecretObject = {fake: 'key'}
        decrypt.mockResolvedValue(new TextEncoder().encode(''))  //→ null webhook, still inserts with rawWebhook
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        const rawSubscription = makeRawSubscription({id: undefined})
        getLastContractEvents.mockResolvedValue({
            events: [makeEvent(['contract', 'created'], [77n, rawSubscription])],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.has(77n)).toBe(true)
        expect(mgr.__subscriptions.get(77n).id).toBe(77n)
    })

    test('deposited event → same dispatch as created', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        getLastContractEvents.mockResolvedValue({
            events: [makeEvent(['contract', 'deposited'], [78n, makeRawSubscription({id: undefined})])],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.has(78n)).toBe(true)
    })

    test('suspended → deletes subscription', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(10n, {id: 10n, webhook: []})
        getLastContractEvents.mockResolvedValue({
            events: [makeEvent(['contract', 'suspended'], [10n])],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.has(10n)).toBe(false)
    })

    test('cancelled → deletes subscription', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(11n, {id: 11n, webhook: []})
        getLastContractEvents.mockResolvedValue({
            events: [makeEvent(['contract', 'cancelled'], [11n])],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.has(11n)).toBe(false)
    })

    test('charged → updates lastCharge from event.value[2]', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(12n, {id: 12n, lastCharge: 0, webhook: []})
        getLastContractEvents.mockResolvedValue({
            events: [makeEvent(['contract', 'charged'], [12n, 'something', 1_700_000n])],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.get(12n).lastCharge).toBe(Number(1_700_000n))
    })

    test('nested triggers topic → dispatch uses topic[2]', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(13n, {id: 13n, webhook: []})
        getLastContractEvents.mockResolvedValue({
            events: [makeEvent(['contract', 'triggers', 'suspended'], [13n])],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.has(13n)).toBe(false)
    })

    test('triggered and updated topics → no-op', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(14n, {id: 14n, webhook: []})
        getLastContractEvents.mockResolvedValue({
            events: [
                makeEvent(['contract', 'triggered'], [14n]),
                makeEvent(['contract', 'updated'], [14n])
            ],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.get(14n)).toEqual({id: 14n, webhook: []})
    })

    test('unknown topic → loop continues, remaining events processed', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(15n, {id: 15n, webhook: []})
        getLastContractEvents.mockResolvedValue({
            events: [
                makeEvent(['contract', 'mystery'], [99n]),
                makeEvent(['contract', 'suspended'], [15n])
            ],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.has(15n)).toBe(false)
    })

    test('throw inside one event does not abort the loop', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        mgr.__subscriptions.set(16n, {id: 16n, webhook: []})
        //A malformed charged event (event.value is not iterable as expected) throws inside the try;
        //the next suspended event must still fire.
        getLastContractEvents.mockResolvedValue({
            events: [
                {topic: ['contract', 'charged'], value: null, timestamp: 1},  //throws on destructure
                makeEvent(['contract', 'suspended'], [16n])
            ],
            lastLedger: 600
        })
        await mgr.processLastEvents()
        expect(mgr.__subscriptions.has(16n)).toBe(false)
    })

    test('__ensureWebhooksDecrypted is called exactly once at the end', async () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__lastLedger = 500
        const spy = jest.spyOn(mgr, '__ensureWebhooksDecrypted').mockResolvedValue(undefined)
        await mgr.processLastEvents()
        expect(spy).toHaveBeenCalledTimes(1)
    })
})

describe('sync data', () => {
    test('verified + newer timestamp → __lastSyncData is set', () => {
        const mgr = new SubscriptionContractManager('c1')
        const data = {syncData: {}, timestamp: Date.now()}
        const newSync = new SubscriptionsSyncData(data)
        newSync.isVerified = true
        mgr.trySetSyncData(newSync)
        expect(mgr.lastSyncData).toBe(newSync)
    })

    test('verified + older timestamp → skipped', () => {
        const mgr = new SubscriptionContractManager('c1')
        const now = Date.now()
        const oldData = {syncData: {}, timestamp: now - 500}
        const newData = {syncData: {}, timestamp: now}
        const newerSync = new SubscriptionsSyncData(newData)
        newerSync.isVerified = true
        const olderSync = new SubscriptionsSyncData(oldData)
        olderSync.isVerified = true
        mgr.trySetSyncData(newerSync)
        mgr.trySetSyncData(olderSync)
        expect(mgr.lastSyncData).toBe(newerSync)
    })

    test('unverified → skipped even when newer', () => {
        const mgr = new SubscriptionContractManager('c1')
        const data = {syncData: {}, timestamp: Date.now()}
        const sync = new SubscriptionsSyncData(data)
        sync.isVerified = false
        mgr.trySetSyncData(sync)
        expect(mgr.lastSyncData).toBeNull()
    })

    test('trySetRawSyncData constructs, awaits calculateHash, adds signatures, delegates', async () => {
        const mgr = new SubscriptionContractManager('c1')
        const rawSyncData = {
            data: {syncData: {}, timestamp: Date.now()},
            signatures: [{pubkey: 'pk1', signature: 'sig1'}]
        }
        await mgr.trySetRawSyncData(rawSyncData)
        expect(SubscriptionsSyncData).toHaveBeenCalledWith(rawSyncData.data)
        const instance = SubscriptionsSyncData.mock.results[0].value
        expect(instance.calculateHash).toHaveBeenCalled()
        expect(instance.tryAddSignature).toHaveBeenCalledWith(rawSyncData.signatures)
        expect(mgr.lastSyncData).toBe(instance)  //isVerified: true by default in mock
    })
})

describe('subscriptions getter', () => {
    test('returns items sorted ascending by BigInt id', () => {
        const mgr = new SubscriptionContractManager('c1')
        mgr.__subscriptions.set(3n, {id: 3n})
        mgr.__subscriptions.set(1n, {id: 1n})
        mgr.__subscriptions.set(2n, {id: 2n})
        expect(mgr.subscriptions.map(s => s.id)).toEqual([1n, 2n, 3n])
    })

    test('returns [] when empty', () => {
        const mgr = new SubscriptionContractManager('c1')
        expect(mgr.subscriptions).toEqual([])
    })
})

describe('module registry (addManager / getManager / removeManager / getAllSubscriptions)', () => {
    afterEach(() => {
        removeManager('cA')
        removeManager('cB')
    })

    test('addManager stores and returns a new manager; getManager retrieves; removeManager deletes', () => {
        const mgr = addManager('cA')
        expect(mgr).toBeInstanceOf(SubscriptionContractManager)
        expect(getManager('cA')).toBe(mgr)
        removeManager('cA')
        expect(getManager('cA')).toBeUndefined()
    })

    test('getAllSubscriptions sorts managers by contractId.localeCompare and flattens', () => {
        const mgrB = addManager('cB')
        const mgrA = addManager('cA')
        mgrA.__subscriptions.set(2n, {id: 2n, tag: 'A2'})
        mgrA.__subscriptions.set(1n, {id: 1n, tag: 'A1'})
        mgrB.__subscriptions.set(1n, {id: 1n, tag: 'B1'})
        const all = getAllSubscriptions()
        //cA sorts before cB; within each manager, ids sort ascending.
        expect(all.map(s => s.tag)).toEqual(['A1', 'A2', 'B1'])
    })
})
