/*eslint-disable no-undef */
const PendingSyncDataCache = require('../../../src/domain/subscriptions/pending-notifications-cache')

/**
 * Build a minimal SubscriptionsSyncData-shaped stub. The cache only reads hashBase64 and calls merge(other), so we
 * avoid the full container boot that real SubscriptionsSyncData needs for hasMajority().
 * @param {{hashBase64: string, timestamp: number, signatures: object[]}} options - stub fields
 * @returns {object} stub
 */
function makeStub({hashBase64, timestamp = 1_700_000_000_000, signatures = []}) {
    return {
        hashBase64,
        timestamp,
        __signatures: [...signatures],
        merge: jest.fn(function mergeSpy(other) {
            for (const s of other.__signatures)
                if (!this.__signatures.some(existing => existing.pubkey === s.pubkey))
                    this.__signatures.push(s)
        })
    }
}

describe('PendingSyncDataCache', () => {
    let nowSpy

    beforeEach(() => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    })

    afterEach(() => {
        nowSpy.mockRestore()
    })

    test('keeps items with different hashes under distinct keys', () => {
        const cache = new PendingSyncDataCache()
        const itemA = makeStub({hashBase64: 'hash-A', signatures: [{pubkey: 'pkA', signature: 'sA'}]})
        const itemB = makeStub({hashBase64: 'hash-B', signatures: [{pubkey: 'pkB', signature: 'sB'}]})

        expect(cache.push(itemA)).toBe(itemA)
        expect(cache.push(itemB)).toBe(itemB)
        expect(itemA.merge).not.toHaveBeenCalled()
        expect(itemB.merge).not.toHaveBeenCalled()
        expect(itemA.__signatures).toEqual([{pubkey: 'pkA', signature: 'sA'}])
        expect(itemB.__signatures).toEqual([{pubkey: 'pkB', signature: 'sB'}])
    })

    test('merges signatures into the first cached item when hashes match', () => {
        const cache = new PendingSyncDataCache()
        const first = makeStub({hashBase64: 'hash-X', signatures: [{pubkey: 'pkA', signature: 'sA'}]})
        const second = makeStub({hashBase64: 'hash-X', signatures: [{pubkey: 'pkB', signature: 'sB'}]})

        expect(cache.push(first)).toBe(first)
        expect(cache.push(second)).toBe(first)
        expect(first.merge).toHaveBeenCalledTimes(1)
        expect(first.merge).toHaveBeenCalledWith(second)
        expect(first.__signatures).toEqual([
            {pubkey: 'pkA', signature: 'sA'},
            {pubkey: 'pkB', signature: 'sB'}
        ])
    })

    test('duplicate pubkey does not overwrite an existing signature', () => {
        const cache = new PendingSyncDataCache()
        const first = makeStub({hashBase64: 'hash-Y', signatures: [{pubkey: 'pkA', signature: 'sA'}]})
        const duplicate = makeStub({hashBase64: 'hash-Y', signatures: [{pubkey: 'pkA', signature: 'sA2'}]})

        cache.push(first)
        cache.push(duplicate)

        expect(first.__signatures).toEqual([{pubkey: 'pkA', signature: 'sA'}])
    })

    test('throws when hashBase64 is missing (guards against pre-calculateHash misuse)', () => {
        const cache = new PendingSyncDataCache()

        expect(() => cache.push(makeStub({hashBase64: null}))).toThrow(/hashBase64 must be set/)
        expect(() => cache.push(makeStub({hashBase64: undefined}))).toThrow(/hashBase64 must be set/)
        expect(() => cache.push(makeStub({hashBase64: ''}))).toThrow(/hashBase64 must be set/)
    })

    test('evicts on the local receive time, not on the peer-supplied payload timestamp', () => {
        const cache = new PendingSyncDataCache()
        //a payload dated far in the future ages out like any other
        cache.push(makeStub({hashBase64: 'hash-future', timestamp: 9_999_999_999_999}))
        expect(cache.__notificationsData.has('hash-future')).toBe(true)

        nowSpy.mockReturnValue(1_000_000 + 2 * 60 * 1000 + 1)
        cache.push(makeStub({hashBase64: 'hash-fresh'}))

        expect(cache.__notificationsData.has('hash-future')).toBe(false)
        expect(cache.__notificationsData.get('hash-fresh').item.hashBase64).toBe('hash-fresh')
    })

    test('keeps an entry mergeable until its retention window has fully elapsed', () => {
        const cache = new PendingSyncDataCache()
        const first = makeStub({hashBase64: 'hash-edge', signatures: [{pubkey: 'pkA', signature: 'sA'}]})
        const second = makeStub({hashBase64: 'hash-edge', signatures: [{pubkey: 'pkB', signature: 'sB'}]})
        cache.push(first)

        //exactly 2 minutes after the local receive. Honest signatures for one round all arrive well inside this, so a
        //shorter window would drop a merge the node needs to reach majority
        nowSpy.mockReturnValue(1_000_000 + 2 * 60 * 1000)

        expect(cache.push(second)).toBe(first)
        expect(first.merge).toHaveBeenCalledWith(second)
    })

    test('a peer can neither shorten an entry\'s life through the payload timestamp nor extend it by re-sending', () => {
        const cache = new PendingSyncDataCache()
        //an ancient payload timestamp: eviction keyed on the payload would drop this entry on the very next push
        const first = makeStub({hashBase64: 'hash-resent', timestamp: 1})
        const resent = makeStub({hashBase64: 'hash-resent', timestamp: 1})
        const late = makeStub({hashBase64: 'hash-resent', timestamp: 1})
        cache.push(first)

        nowSpy.mockReturnValue(1_000_000 + 60 * 1000)
        expect(cache.push(resent)).toBe(first)

        //the re-send did not refresh the receive time, so the entry expires 2 minutes after the FIRST receive, and a
        //later copy starts a fresh entry rather than reviving the stale one
        nowSpy.mockReturnValue(1_000_000 + 2 * 60 * 1000 + 1)
        expect(cache.push(late)).toBe(late)
        expect(first.merge).toHaveBeenCalledTimes(1)
    })

    test('caps each sender at eight entries and refuses only that sender\'s next one', () => {
        const cache = new PendingSyncDataCache()
        for (let i = 0; i < 8; i++)
            cache.push(makeStub({hashBase64: `hash-M-${i}`}), 'peer-M')
        const refused = makeStub({hashBase64: 'hash-M-8'})

        //a refused item is handed back uncached, so the caller can still adopt it if it carries a majority on its own
        expect(cache.push(refused, 'peer-M')).toBe(refused)
        expect(cache.__notificationsData.has('hash-M-8')).toBe(false)
        expect(cache.__entriesBySender.get('peer-M')).toBe(8)
        cache.push(makeStub({hashBase64: 'hash-B-0'}), 'peer-B')
        expect(cache.__notificationsData.has('hash-B-0')).toBe(true)
    })

    test('no flood from one sender, however long, evicts another sender\'s entry', () => {
        const cache = new PendingSyncDataCache()
        const own = makeStub({hashBase64: 'hash-own', signatures: [{pubkey: 'pkA', signature: 'sA'}]})
        cache.push(own, 'local')
        for (let i = 0; i < 1000; i++)
            cache.push(makeStub({hashBase64: `hash-M-${i}`}), 'peer-M')

        expect(cache.__notificationsData.size).toBe(9)
        const copy = makeStub({hashBase64: 'hash-own', signatures: [{pubkey: 'pkB', signature: 'sB'}]})
        expect(cache.push(copy, 'peer-B')).toBe(own)
        expect(own.merge).toHaveBeenCalledWith(copy)
    })

    test('an entry that reaches a majority leaves the cache and refunds the sender that opened it', () => {
        const cache = new PendingSyncDataCache()
        const opened = makeStub({hashBase64: 'hash-M-0'})
        opened.merge.mockImplementation(function markVerified() {
            this.isVerified = true
        })
        cache.push(opened, 'peer-M')
        for (let i = 1; i < 8; i++)
            cache.push(makeStub({hashBase64: `hash-M-${i}`}), 'peer-M')

        //the copy that completes the majority comes from another sender; the refund goes to the one that opened it
        expect(cache.push(makeStub({hashBase64: 'hash-M-0'}), 'peer-B')).toBe(opened)

        expect(cache.__notificationsData.has('hash-M-0')).toBe(false)
        expect(cache.__entriesBySender.get('peer-M')).toBe(7)
        expect(cache.__entriesBySender.has('peer-B')).toBe(false)
        cache.push(makeStub({hashBase64: 'hash-M-8'}), 'peer-M')
        expect(cache.__notificationsData.has('hash-M-8')).toBe(true)
    })

    test('an entry that expires refunds the sender that opened it', () => {
        const cache = new PendingSyncDataCache()
        for (let i = 0; i < 8; i++)
            cache.push(makeStub({hashBase64: `hash-M-${i}`}), 'peer-M')

        nowSpy.mockReturnValue(1_000_000 + 2 * 60 * 1000 + 1)
        cache.push(makeStub({hashBase64: 'hash-M-8'}), 'peer-M')

        expect(cache.__notificationsData.size).toBe(1)
        expect(cache.__notificationsData.has('hash-M-8')).toBe(true)
        expect(cache.__entriesBySender.get('peer-M')).toBe(1)
    })

    test('a majority-signed item is handed back without taking a slot, even from a sender at its quota', () => {
        const cache = new PendingSyncDataCache()
        const verified = makeStub({hashBase64: 'hash-verified'})
        verified.isVerified = true

        expect(cache.push(verified, 'peer-B')).toBe(verified)
        expect(cache.__notificationsData.size).toBe(0)
        expect(cache.__entriesBySender.has('peer-B')).toBe(false)

        for (let i = 0; i < 8; i++)
            cache.push(makeStub({hashBase64: `hash-M-${i}`}), 'peer-M')
        const relayed = makeStub({hashBase64: 'hash-relayed'})
        relayed.isVerified = true
        expect(cache.push(relayed, 'peer-M')).toBe(relayed)
        expect(cache.__entriesBySender.get('peer-M')).toBe(8)
    })

    test('never holds more than the entry cap: once full it refuses new entries and keeps every entry it holds', () => {
        const cache = new PendingSyncDataCache()
        //nine senders at their full quota offer 72 entries; the first 64 fit and the last eight do not
        for (let sender = 0; sender < 9; sender++)
            for (let i = 0; i < 8; i++)
                cache.push(makeStub({hashBase64: `hash-${sender}-${i}`}), `peer-${sender}`)

        expect(cache.__notificationsData.size).toBe(64)
        expect(cache.__notificationsData.has('hash-0-0')).toBe(true)
        expect(cache.__notificationsData.has('hash-7-7')).toBe(true)
        expect(cache.__notificationsData.has('hash-8-0')).toBe(false)
        expect(cache.__entriesBySender.has('peer-8')).toBe(false)
    })
})
