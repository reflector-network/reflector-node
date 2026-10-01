/*eslint-disable no-undef */
/*
 * Drives the SYNC path on the real modules - payload parsing, SubscriptionsSyncData, sha256 and ed25519 - for a
 * three-node cluster: A is this node, B an honest peer and M an authenticated cluster member that floods. Only the
 * container and the data-sources manager are replaced, and tests/setup.js mocks the logger.
 */

jest.mock('../../../src/domain/container', () => ({settingsManager: {config: {nodes: new Map()}}}))

jest.mock('../../../src/domain/data-sources-manager', () => ({
    has: () => true,
    isStellarSource: () => false
}))

const {Keypair} = require('@stellar/stellar-sdk')
const container = require('../../../src/domain/container')
const SubscriptionsSyncData = require('../../../src/domain/subscriptions/subscriptions-sync-data')
const {SubscriptionContractManager} = require('../../../src/domain/subscriptions/subscriptions-data-manager')

const now = 1_700_000_000_000
const round = now - 60 * 1000 //a completed timeframe, as the runner produces
const nodeA = Keypair.random() //this node
const nodeB = Keypair.random() //honest peer
const nodeM = Keypair.random() //authenticated peer that floods

/**
 * @param {...Keypair} signers - nodes that sign the round's sync data
 * @returns {Promise<SubscriptionsSyncData>} the round's sync data carrying exactly those signatures
 */
async function roundSignedBy(...signers) {
    const item = new SubscriptionsSyncData({syncData: {'7': {lastNotification: round, lastPrice: '12345'}}, timestamp: round})
    await item.calculateHash()
    for (const signer of signers)
        item.sign(signer)
    return item
}

/**
 * Sends payloads that cost the sender nothing: no signature to verify, and an ancient timestamp that passes the shape
 * check and the window, which has no lower bound so that a restarted node can recover
 * @param {SubscriptionContractManager} manager - receiving manager
 * @param {number} count - number of payloads
 * @param {number} [first] - timestamp of the first payload
 */
async function flood(manager, count, first = 1) {
    for (let i = first; i < first + count; i++)
        await manager.trySetRawSyncData({data: {syncData: {}, timestamp: i}, signatures: []}, nodeM.publicKey())
}

/**
 * @param {SubscriptionsSyncData} item - sync data
 * @returns {string[]} public keys of the nodes whose signatures the item carries, in the order they were added
 */
function signersOf(item) {
    return item.toPlainObject().signatures.map(s => s.pubkey)
}

/**
 * @param {SubscriptionContractManager} manager - manager
 * @param {Keypair} node - sender
 * @returns {number} pending entries charged to that sender
 */
function pendingOf(manager, node) {
    return [...manager.__pendingSyncData.__notificationsData.values()].filter(e => e.sender === node.publicKey()).length
}

describe('pending sync data under a flood from one authenticated peer', () => {
    let nowSpy

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
        container.settingsManager.config.nodes = new Map([nodeA, nodeB, nodeM].map(k => [k.publicKey(), {pubkey: k.publicKey()}]))
    })

    afterEach(() => {
        nowSpy.mockRestore()
    })

    test.each([64, 1000])('%i unsigned payloads between this node\'s own item and an honest copy do not stop the majority', async count => {
        const manager = new SubscriptionContractManager('contract-1')
        const own = await roundSignedBy(nodeA)
        manager.trySetSyncData(own, nodeA.publicKey()) //the runner pushes its own item once its trigger tx lands

        await flood(manager, count)
        await manager.trySetRawSyncData((await roundSignedBy(nodeB)).toPlainObject(), nodeB.publicKey())

        //__lastSyncData starts as null, so only identity proves adoption: B's copy merged into this node's own entry
        expect(manager.lastSyncData).toBe(own)
        expect(signersOf(own)).toEqual([nodeA.publicKey(), nodeB.publicKey()])
    })

    test('a flood that arrives before this node\'s own item cannot keep it out of the cache', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        await flood(manager, 1000)

        const own = await roundSignedBy(nodeA)
        manager.trySetSyncData(own, nodeA.publicKey())
        await manager.trySetRawSyncData((await roundSignedBy(nodeB)).toPlainObject(), nodeB.publicKey())

        expect(manager.lastSyncData).toBe(own)
        expect(signersOf(own)).toEqual([nodeA.publicKey(), nodeB.publicKey()])
        expect(pendingOf(manager, nodeM)).toBe(8)
    })

    test('a flood cannot keep out an honest copy that arrives ahead of this node\'s own item', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        await flood(manager, 1000)
        await manager.trySetRawSyncData((await roundSignedBy(nodeB)).toPlainObject(), nodeB.publicKey())

        const own = await roundSignedBy(nodeA)
        manager.trySetSyncData(own, nodeA.publicKey())

        //the entry B opened is the one adopted, now carrying this node's signature as well
        expect(manager.lastSyncData?.hashBase64).toBe(own.hashBase64)
        expect(signersOf(manager.lastSyncData)).toEqual([nodeB.publicKey(), nodeA.publicKey()])
    })

    test('a majority-signed copy is adopted even from a peer that has exhausted its quota', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        await flood(manager, 1000)

        //sync signatures carry no sender binding, so M can relay a copy that A and B signed
        await manager.trySetRawSyncData((await roundSignedBy(nodeA, nodeB)).toPlainObject(), nodeM.publicKey())

        expect(manager.lastSyncData?.hashBase64).toBe((await roundSignedBy()).hashBase64)
        expect(signersOf(manager.lastSyncData)).toEqual([nodeA.publicKey(), nodeB.publicKey()])
        expect(pendingOf(manager, nodeM)).toBe(8)
    })

    test('an adopted entry refunds the quota of the peer that opened it', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        //M delivers the round first, so the entry is charged to M, then fills the rest of its quota
        await manager.trySetRawSyncData((await roundSignedBy(nodeM)).toPlainObject(), nodeM.publicKey())
        await flood(manager, 8)
        expect(pendingOf(manager, nodeM)).toBe(8)

        const own = await roundSignedBy(nodeA)
        manager.trySetSyncData(own, nodeA.publicKey()) //A and M are a majority of three

        expect(manager.lastSyncData?.hashBase64).toBe(own.hashBase64)
        expect(pendingOf(manager, nodeM)).toBe(7)
        const next = new SubscriptionsSyncData({syncData: {}, timestamp: 5000})
        await next.calculateHash()
        await flood(manager, 1, 5000)
        expect(manager.__pendingSyncData.__notificationsData.has(next.hashBase64)).toBe(true)
        expect(pendingOf(manager, nodeM)).toBe(8)
    })

    test('a later copy of the adopted item adds its signature to it without taking a slot', async () => {
        const manager = new SubscriptionContractManager('contract-1')
        const own = await roundSignedBy(nodeA)
        manager.trySetSyncData(own, nodeA.publicKey())
        await manager.trySetRawSyncData((await roundSignedBy(nodeB)).toPlainObject(), nodeB.publicKey())

        await manager.trySetRawSyncData((await roundSignedBy(nodeM)).toPlainObject(), nodeM.publicKey())

        expect(manager.lastSyncData).toBe(own)
        expect(signersOf(own)).toEqual([nodeA.publicKey(), nodeB.publicKey(), nodeM.publicKey()])
        expect(manager.__pendingSyncData.__notificationsData.size).toBe(0)
    })
})
