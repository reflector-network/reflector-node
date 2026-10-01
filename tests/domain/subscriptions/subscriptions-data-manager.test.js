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
    AssetType: {STELLAR: 'stellar', OTHER: 'other'},
    compareStrings: (a, b) => (a < b ? -1 : (a > b ? 1 : 0))
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
            //the pubkey must be a 56-character strkey, otherwise parseRawSyncData rejects the payload
            data: {syncData: {}, timestamp: Date.now()},
            signatures: [{pubkey: `G${'A'.repeat(55)}`, signature: 'sig1'}]
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

    test('getAllSubscriptions sorts managers by contractId in code-unit order and flattens', () => {
        const mgrB = addManager('cB')
        const mgrA = addManager('cA')
        mgrA.__subscriptions.set(2n, {id: 2n, tag: 'A2'})
        mgrA.__subscriptions.set(1n, {id: 1n, tag: 'A1'})
        mgrB.__subscriptions.set(1n, {id: 1n, tag: 'B1'})
        const all = getAllSubscriptions()
        //cA sorts before cB; within each manager, ids sort ascending.
        expect(all.map(s => s.tag)).toEqual(['A1', 'A2', 'B1'])
    })

    test('getAllSubscriptions orders contractId by code unit, not locale collation', () => {
        //code-unit: 'B' (U+0042) sorts before 'a' (U+0061); the en locale collates case-insensitively
        //and would reverse it, so this fixture only passes under a genuine code-unit comparator
        expect('B'.localeCompare('a')).toBe(1)
        const mgrLower = addManager('a1')
        const mgrUpper = addManager('B1')
        mgrLower.__subscriptions.set(1n, {id: 1n, tag: 'lower'})
        mgrUpper.__subscriptions.set(1n, {id: 1n, tag: 'upper'})
        try {
            const all = getAllSubscriptions()
            expect(all.map(s => s.tag)).toEqual(['upper', 'lower'])
        } finally {
            removeManager('a1')
            removeManager('B1')
        }
    })
})

describe('trySetRawSyncData payload shape', () => {
    //56 characters, the length parseRawSyncData requires of an ed25519 strkey
    const signerPubkey = `G${'A'.repeat(55)}`

    /**
     * @returns {object} a well-formed raw SYNC payload
     */
    function goodPayload() {
        return {
            data: {syncData: {'7': {lastNotification: 1_700_000_000_000, lastPrice: '12345'}}, timestamp: 1_700_000_040_000},
            signatures: [{pubkey: signerPubkey, signature: 'c2ln'}]
        }
    }

    test('a well-formed payload reaches SubscriptionsSyncData with exactly syncData and timestamp', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        const payload = goodPayload()
        payload.data.padding = 'x'.repeat(100) //extra fields must not reach the hash

        await manager.trySetRawSyncData(payload)

        expect(SubscriptionsSyncData).toHaveBeenCalledTimes(1)
        expect(SubscriptionsSyncData.mock.calls[0][0]).toEqual({
            syncData: {'7': {lastNotification: 1_700_000_000_000, lastPrice: '12345'}},
            timestamp: 1_700_000_040_000
        })
    })

    const badPayloads = {
        'no data': {signatures: []},
        'data is an array': {data: [], signatures: []},
        'timestamp is a string': {data: {syncData: {}, timestamp: '1700000040000'}, signatures: []},
        'timestamp is negative': {data: {syncData: {}, timestamp: -1}, signatures: []},
        'syncData is an array': {data: {syncData: [], timestamp: 1_700_000_040_000}, signatures: []},
        //built through JSON.parse because that is how a SYNC frame arrives: an object literal's `'__proto__':` is the
        //prototype setter, so it would leave syncData with no own keys at all and never reach the key check
        'syncData key is not a subscription id': {data: JSON.parse('{"syncData":{"__proto__":{"lastNotification":1,"lastPrice":"1"}},"timestamp":1700000040000}'), signatures: []},
        'lastPrice is not a decimal string': {data: {syncData: {'7': {lastNotification: 1, lastPrice: 1}}, timestamp: 1_700_000_040_000}, signatures: []},
        'lastNotification is not an integer': {data: {syncData: {'7': {lastNotification: 'now', lastPrice: '1'}}, timestamp: 1_700_000_040_000}, signatures: []},
        'entry carries an extra field': {data: {syncData: {'7': {lastNotification: 1, lastPrice: '1', extra: true}}, timestamp: 1_700_000_040_000}, signatures: []},
        'signatures is not an array': {data: {syncData: {}, timestamp: 1_700_000_040_000}, signatures: {}},
        'signature entry is not an object': {data: {syncData: {}, timestamp: 1_700_000_040_000}, signatures: ['nope']}
    }

    for (const [name, payload] of Object.entries(badPayloads)) {
        test(`rejects a payload where ${name}`, async () => {
            const manager = new SubscriptionContractManager('contract-1')

            await expect(manager.trySetRawSyncData(payload)).resolves.toBeUndefined()

            expect(SubscriptionsSyncData).not.toHaveBeenCalled()
            //__lastSyncData is initialised to null (subscriptions-data-manager.js:167) and the getter returns it
            //verbatim, so toBeUndefined() would fail against a correct implementation
            expect(manager.lastSyncData).toBeNull()
        })
    }

    test('rebuilds signature entries so a peer cannot smuggle extra fields into the broadcast', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        const payload = goodPayload()
        payload.signatures = [{pubkey: signerPubkey, signature: 'c2ln', extra: 'x'}]

        await manager.trySetRawSyncData(payload)

        expect(SubscriptionsSyncData).toHaveBeenCalledTimes(1)
        //the suite's SubscriptionsSyncData mock returns an object literal, so mock.results[0].value is the instance
        const instance = SubscriptionsSyncData.mock.results[0].value
        expect(instance.tryAddSignature).toHaveBeenCalledWith([{pubkey: signerPubkey, signature: 'c2ln'}])
    })

    test('rejects a signature entry whose pubkey is the wrong length', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        const payload = goodPayload()
        payload.signatures = [{pubkey: 'G'.repeat(57), signature: 'c2ln'}]

        await manager.trySetRawSyncData(payload)

        expect(SubscriptionsSyncData).not.toHaveBeenCalled()
    })

    test('rejects a signature string longer than the bound', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        const payload = goodPayload()
        payload.signatures = [{pubkey: signerPubkey, signature: 'c'.repeat(129)}]

        await manager.trySetRawSyncData(payload)

        expect(SubscriptionsSyncData).not.toHaveBeenCalled()
    })

    /**
     * @param {string} lastPrice - lastPrice of the only entry
     * @returns {object} a well-formed raw SYNC payload carrying that price
     */
    function payloadWithPrice(lastPrice) {
        const payload = goodPayload()
        payload.data.syncData['7'].lastPrice = lastPrice
        return payload
    }

    test.each([
        //getVWAP(10^100, 10^20, 14): a public subscriber can make honest volumes this long on pubnet
        ['a 95-digit price', 95],
        ['a 120-digit price', 120],
        //the volume bound is 1000 digits; getVWAP and calcCrossPrice each scale by 10^decimals on top of it
        ['a price of 1028 digits, the largest volume the price sync accepts restated twice at 14 decimals', 1028],
        ['a price at the 1100-digit bound', 1100]
    ])('accepts %s', async (_, digits) => {
        const manager = new SubscriptionContractManager('contract-1')
        const lastPrice = '9'.repeat(digits)

        await manager.trySetRawSyncData(payloadWithPrice(lastPrice))

        expect(SubscriptionsSyncData).toHaveBeenCalledTimes(1)
        expect(SubscriptionsSyncData.mock.calls[0][0].syncData['7'].lastPrice).toBe(lastPrice)
    })

    test('rejects a price one digit past the 1100-digit bound', async () => {
        const manager = new SubscriptionContractManager('contract-1')

        await manager.trySetRawSyncData(payloadWithPrice('9'.repeat(1101)))

        expect(SubscriptionsSyncData).not.toHaveBeenCalled()
        expect(manager.lastSyncData).toBeNull()
    })

    test('keeps subscription ids to 40 digits while prices may run longer', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        const payload = goodPayload()
        payload.data.syncData = {['1'.repeat(41)]: {lastNotification: 1, lastPrice: '1'}}

        await manager.trySetRawSyncData(payload)

        expect(SubscriptionsSyncData).not.toHaveBeenCalled()
    })

    /**
     * @param {number} count - number of entries to build
     * @returns {Object.<string, {lastNotification: number, lastPrice: string}>} a syncData map of that size
     */
    function syncDataOfSize(count) {
        const syncData = {}
        for (let i = 0; i < count; i++)
            syncData[String(i)] = {lastNotification: 1, lastPrice: '1'}
        return syncData
    }

    /**
     * Stands in for a majority-signed SubscriptionsSyncData the manager already holds. The real class derives `size`
     * from Object.keys(__data.syncData).length — pinned by 'size counts the entries the item holds' in the sync-data
     * suite — and this file mocks that class away, so the stub carries only what the cap derivation reads.
     * @param {number} size - number of entries the cluster has already agreed on
     * @returns {{size: number, timestamp: number}}
     */
    function agreedSyncData(size) {
        return {size, timestamp: 1_700_000_000_000}
    }

    test('a cold contract accepts a payload at the floor', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        //nothing agreed and nothing live, so the cap is the floor: minSyncDataEntries

        await manager.trySetRawSyncData({data: {syncData: syncDataOfSize(4096), timestamp: 1_700_000_040_000}, signatures: []})

        expect(SubscriptionsSyncData).toHaveBeenCalledTimes(1)
    })

    test('a cold contract rejects a payload one entry above the floor', async () => {
        const manager = new SubscriptionContractManager('contract-1')

        await manager.trySetRawSyncData({data: {syncData: syncDataOfSize(4097), timestamp: 1_700_000_040_000}, signatures: []})

        expect(SubscriptionsSyncData).not.toHaveBeenCalled()
    })

    test('a churned contract accepts the agreed set plus one tick of live triggers', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        //5000 subscriptions have ever triggered, only 10 are still live. A cap read off the live count would sit at the
        //floor and reject this payload forever, freezing sync and firing every subscription by heartbeat every tick
        manager.__lastSyncData = agreedSyncData(5000)
        for (let i = 0; i < 10; i++)
            manager.__subscriptions.set(BigInt(i), {id: BigInt(i), webhook: []})

        await manager.trySetRawSyncData({data: {syncData: syncDataOfSize(5005), timestamp: 1_700_000_040_000}, signatures: []})

        expect(SubscriptionsSyncData).toHaveBeenCalledTimes(1)
    })

    test('a churned contract still refuses a payload above the derived cap', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        //the cap is 5000 agreed + 10 live, and no honest peer can produce a 5011th entry in a single tick
        manager.__lastSyncData = agreedSyncData(5000)
        for (let i = 0; i < 10; i++)
            manager.__subscriptions.set(BigInt(i), {id: BigInt(i), webhook: []})

        await manager.trySetRawSyncData({data: {syncData: syncDataOfSize(5011), timestamp: 1_700_000_040_000}, signatures: []})

        expect(SubscriptionsSyncData).not.toHaveBeenCalled()
    })
})

describe('trySetSyncData timestamp window', () => {
    let nowSpy

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    })

    afterEach(() => {
        nowSpy.mockRestore()
    })

    /**
     * @param {number} timestamp - payload timestamp
     * @returns {object} a verified sync-data stub
     */
    function syncItem(timestamp) {
        return {timestamp, isVerified: true, hashBase64: `hash-${timestamp}`, __signatures: [], merge: jest.fn()}
    }

    test('adopts a payload timestamped within one timeframe of the local clock', () => {
        const manager = new SubscriptionContractManager('contract-1')
        const item = syncItem(1_700_000_000_000)

        manager.trySetSyncData(item)

        //__lastSyncData starts as null, which toBeDefined() also accepts, so only identity proves the item was adopted
        expect(manager.lastSyncData).toBe(item)
    })

    test('refuses a payload dated further ahead than one timeframe, so it cannot pin the state', () => {
        const manager = new SubscriptionContractManager('contract-1')

        manager.trySetSyncData(syncItem(9_999_999_999_999))

        //__lastSyncData is initialised to null (subscriptions-data-manager.js:228), never undefined
        expect(manager.lastSyncData).toBeNull()
    })

    test('still adopts an older payload, so a restarted node can recover state from its peers', () => {
        const manager = new SubscriptionContractManager('contract-1')
        const item = syncItem(1_700_000_000_000 - 6 * 60 * 60 * 1000)

        manager.trySetSyncData(item)

        expect(manager.lastSyncData).toBe(item)
    })

    test('the window closes exactly one timeframe ahead, and a refused payload never reaches the cache', () => {
        const manager = new SubscriptionContractManager('contract-1')
        const atEdge = syncItem(1_700_000_000_000 + 60 * 1000)
        //newer than atEdge, so only the window can stop it replacing atEdge
        const beyond = syncItem(1_700_000_000_000 + 60 * 1000 + 1)
        //a majority-signed item never stays in the pending cache, so only the calls to it show that the refused
        //payload was stopped before the cache rather than dropped by it
        const pushSpy = jest.spyOn(manager.__pendingSyncData, 'push')

        manager.trySetSyncData(atEdge)
        manager.trySetSyncData(beyond)

        expect(manager.lastSyncData).toBe(atEdge)
        expect(pushSpy).toHaveBeenCalledTimes(1)
        expect(pushSpy.mock.calls[0][0]).toBe(atEdge)
    })
})
