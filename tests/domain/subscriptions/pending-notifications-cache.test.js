/*eslint-disable no-undef */
const PendingSyncDataCache = require('../../../src/domain/subscriptions/pending-notifications-cache')

/**
 * Build a minimal SubscriptionsSyncData-shaped stub. The cache only reads hashBase64 / timestamp
 * and calls merge(other), so we avoid the full container boot that real SubscriptionsSyncData
 * needs for hasMajority().
 */
function makeStub({hashBase64, timestamp = Date.now(), signatures = []}) {
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
    test('keeps items with different hashes under distinct keys (would catch the __hashBase64 typo)', () => {
        const cache = new PendingSyncDataCache()
        const itemA = makeStub({hashBase64: 'hash-A', signatures: [{pubkey: 'pkA', signature: 'sA'}]})
        const itemB = makeStub({hashBase64: 'hash-B', signatures: [{pubkey: 'pkB', signature: 'sB'}]})

        const returnedA = cache.push(itemA)
        const returnedB = cache.push(itemB)

        expect(returnedA).toBe(itemA)
        expect(returnedB).toBe(itemB)
        expect(itemA.merge).not.toHaveBeenCalled()
        expect(itemB.merge).not.toHaveBeenCalled()
        //signatures must stay isolated per snapshot — no cross-hash contamination
        expect(itemA.__signatures).toEqual([{pubkey: 'pkA', signature: 'sA'}])
        expect(itemB.__signatures).toEqual([{pubkey: 'pkB', signature: 'sB'}])
    })

    test('merges signatures into the first cached item when hashes match', () => {
        const cache = new PendingSyncDataCache()
        const first = makeStub({hashBase64: 'hash-X', signatures: [{pubkey: 'pkA', signature: 'sA'}]})
        const second = makeStub({hashBase64: 'hash-X', signatures: [{pubkey: 'pkB', signature: 'sB'}]})

        const returnedFirst = cache.push(first)
        const returnedSecond = cache.push(second)

        //second push returns the already-cached item so trySetSyncData reads the merged view
        expect(returnedFirst).toBe(first)
        expect(returnedSecond).toBe(first)
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

    test('drops items whose timestamp is older than the 2-minute retention window', () => {
        const cache = new PendingSyncDataCache()
        const now = 1000000
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
        const retentionMs = 2 * 60 * 1000

        const stale = makeStub({hashBase64: 'hash-stale', timestamp: now - retentionMs - 1})
        cache.push(stale)
        //__cleanup runs at the end of push() and prunes anything older than the window
        expect(cache.__notificationsData['hash-stale']).toBeUndefined()

        const fresh = makeStub({hashBase64: 'hash-fresh', timestamp: now})
        cache.push(fresh)
        expect(cache.__notificationsData['hash-fresh']).toBe(fresh)

        nowSpy.mockRestore()
    })
})
