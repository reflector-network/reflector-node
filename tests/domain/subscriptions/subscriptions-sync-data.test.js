/*eslint-disable no-undef */
/*
 * Exercises SubscriptionsSyncData.tryAddSignature — in particular the batch
 * semantics when the input contains a duplicate or invalid signature.
 *
 * Pre-fix behaviour: `return` on either the duplicate-check or the signature-
 * verification branch abandoned the entire batch. Post-fix: `continue` skips
 * just the offending entry. The tests lock in the post-fix semantics and act
 * as regression anchors against reverting to `return`.
 */

jest.mock('../../../src/domain/container', () => ({
    settingsManager: {config: {nodes: new Map()}}
}))

//Names prefixed with `mock` are allowed to cross into jest.mock factories.
const mockVerify = jest.fn()

jest.mock('@stellar/stellar-sdk', () => ({
    Keypair: {
        fromPublicKey: (pubkey) => ({
            pubkey,
            verify: (...args) => mockVerify(pubkey, ...args)
        })
    }
}))

const container = require('../../../src/domain/container')
const SubscriptionsSyncData = require('../../../src/domain/subscriptions/subscriptions-sync-data')

/**
 * Helper to build a fresh instance with a known hash so verify-path tests
 * can be deterministic.
 * @param {number} clusterSize - number of nodes in the cluster (majority math)
 * @returns {SubscriptionsSyncData}
 */
function makeItem(clusterSize = 3) {
    container.settingsManager.config.nodes = new Map(
        Array.from({length: clusterSize}, (_, i) => [`node-${i}`, {}])
    )
    const item = new SubscriptionsSyncData({syncData: {}, timestamp: 1_000_000})
    item.hash = Buffer.from('deadbeef', 'hex')
    item.hashBase64 = item.hash.toString('base64')
    return item
}

/**
 * Build a signature entry. The `signature` value is only meaningful when the
 * verify path runs (verified=false). We base64-encode a tag so Buffer.from
 * decoding succeeds.
 * @param {string} pubkey
 * @param {string} [tag]
 * @returns {{pubkey: string, signature: string}}
 */
function sig(pubkey, tag = 'sig') {
    return {pubkey, signature: Buffer.from(`${pubkey}:${tag}`).toString('base64')}
}

describe('SubscriptionsSyncData.tryAddSignature', () => {
    beforeEach(() => {
        mockVerify.mockReset()
    })

    describe('verified=true (no signature check)', () => {
        test('adds a single signature', () => {
            const item = makeItem()
            item.tryAddSignature([sig('A')], true)

            expect(item.toPlainObject().signatures).toEqual([sig('A')])
        })

        test('skips duplicate pubkey but continues with the rest of the batch', () => {
            const item = makeItem()
            item.tryAddSignature([sig('A')], true)

            //Batch where the FIRST entry duplicates — the bug was to return here.
            //Post-fix: 'B' and 'C' are still added.
            item.tryAddSignature([sig('A', 'other'), sig('B'), sig('C')], true)

            const pubkeys = item.toPlainObject().signatures.map(s => s.pubkey)
            expect(pubkeys).toEqual(['A', 'B', 'C'])
        })

        test('bug confirmation: under the legacy `return` semantics later sigs would be dropped', () => {
            //Mechanical model of pre-fix loop: `return` on first duplicate.
            const seen = new Set(['A'])
            const batch = ['A', 'B', 'C']
            const accepted = []
            for (const pk of batch) {
                if (seen.has(pk))
                    break  //`return` analogue
                accepted.push(pk)
                seen.add(pk)
            }
            expect(accepted).toEqual([])  //nothing was ever added → demonstrates the bug
        })

        test('flips isVerified once majority is reached', () => {
            const item = makeItem(3)  //majority = 2
            expect(item.isVerified).toBe(false)

            item.tryAddSignature([sig('A')], true)
            expect(item.isVerified).toBe(false)

            item.tryAddSignature([sig('B')], true)
            expect(item.isVerified).toBe(true)
        })

        test('isVerified remains true once set, even if later calls add only duplicates', () => {
            const item = makeItem(3)
            item.tryAddSignature([sig('A'), sig('B')], true)
            expect(item.isVerified).toBe(true)

            item.tryAddSignature([sig('A'), sig('B')], true)  //all duplicates
            expect(item.isVerified).toBe(true)
        })
    })

    describe('verified=false (signature check path)', () => {
        test('adds signature when verify returns true', () => {
            mockVerify.mockReturnValue(true)
            const item = makeItem()

            item.tryAddSignature([sig('A')])

            expect(item.toPlainObject().signatures).toEqual([sig('A')])
            expect(mockVerify).toHaveBeenCalledWith('A', item.hash, expect.any(Buffer))
        })

        test('skips invalid signature but keeps going with later valid ones', () => {
            //First verify returns false (bad), second returns true (good).
            mockVerify.mockImplementation((pubkey) => pubkey !== 'bad')
            const item = makeItem()

            item.tryAddSignature([sig('bad'), sig('good')])

            const pubkeys = item.toPlainObject().signatures.map(s => s.pubkey)
            expect(pubkeys).toEqual(['good'])
        })
    })

    describe('merge', () => {
        test('combines signatures from another instance, skipping overlap', () => {
            const a = makeItem(5)  //majority = 3
            a.tryAddSignature([sig('A'), sig('B')], true)

            const b = makeItem(5)
            b.tryAddSignature([sig('B'), sig('C'), sig('D')], true)

            a.merge(b)

            const pubkeys = a.toPlainObject().signatures.map(s => s.pubkey)
            expect(pubkeys.sort()).toEqual(['A', 'B', 'C', 'D'])
            expect(a.isVerified).toBe(true)
        })

        test('bug regression: overlapping first signer does not drop the rest of the merge', () => {
            //This scenario was the real-world bite of the bug: two peers gossip
            //their sync data; the first pubkey in `other.__signatures` is the
            //common one. Pre-fix, `return` dropped every later signature and
            //the merged result never reached majority.
            const a = makeItem(5)  //majority = 3
            a.tryAddSignature([sig('A')], true)

            const b = makeItem(5)
            b.tryAddSignature([sig('A'), sig('B'), sig('C')], true)

            a.merge(b)

            expect(a.toPlainObject().signatures.map(s => s.pubkey).sort()).toEqual(['A', 'B', 'C'])
            expect(a.isVerified).toBe(true)
        })
    })
})
