const logger = require('../../logger')

/**
 * @typedef {import('./subscriptions-sync-data')} SubscriptionsSyncData
 */

const retentionMs = 2 * 60 * 1000 //2 minutes
//A slot is held only by an item still short of a majority here, from its first receipt until it is verified or
//retentionMs passes; a merge into an existing entry never needs one. An honest node opens slots with two kinds of item,
//at most one of each per round. Its own round's item is sent once, after its trigger tx lands
//(subscriptions-runner.js:149-152), between T + delay and the last attempt's maxTime, T + delay + 60 s (runner-base.js
//getMaxTime: 30 s + 2 x 15 s), so own items of rounds up to 120 + 60 = 180 s apart can land inside one retention
//window: 180 / 60 + 1 = 4 rounds. The item it adopted is re-sent every tick (:80) and on a peer's READY
//(state-handler.js:19); it is majority-signed, so it takes a slot only while this node counts it against a different
//node set, and it differs from the own item only in a round the sender was outvoted in. Allowing it the same 4 rounds
//gives 2 x 4 = 8. There is no clock-skew factor: the receive time and the cleanup both read this node's clock, and the
//sender's ticks are 60 s apart on its own. Where the node sets agree, a node on the majority side holds a slot only
//until its round is verified here; past 8 there is only a hash this node cannot need - a minority own item, or an
//adopted one it can also take from its own entry or from any other node's copy.
const maxEntriesPerSender = 8
//The memory bound, not the flood defence; the per-sender quota is. Eight senders at a full quota fill it, and eight
//nodes are a minority only from 16 nodes upwards (a majority is floor(n / 2) + 1); live honest entries lower that a
//little. Once it is full a new entry is refused rather than evicting one, so an entry already held - this node's own
//included - stays mergeable until it is verified or expires.
const maxEntries = 64

class PendingSyncDataCache {

    /**
     * Sync payloads still short of a majority, keyed by payload hash, in insertion order. Each is stamped with the
     * LOCAL receive time - the payload's own timestamp is peer-supplied and must never drive eviction - and charged to
     * the node that opened it.
     * @type {Map<string, {item: SubscriptionsSyncData, receivedAt: number, sender: string}>}
     */
    __notificationsData = new Map()

    /**
     * Number of entries each node has opened, so an entry can be charged back when it leaves
     * @type {Map<string, number>}
     */
    __entriesBySender = new Map()

    /**
     * @param {SubscriptionsSyncData} newItem - new item
     * @param {string} sender - public key of the node the item came from; this node's own for its own round
     * @returns {SubscriptionsSyncData} - the cached item after a merge, otherwise the new item, cached or refused
     */
    push(newItem, sender) {
        if (!newItem.hashBase64)
            throw new Error('SubscriptionsSyncData.hashBase64 must be set before push (call calculateHash first)')
        //cleanup runs BEFORE the lookup, not after the merge. The consequence is
        //deliberate: a merge does not refresh receivedAt, so a hash peers keep re-sending still ages out 2 minutes
        //after this node first saw it. That is the replay bound - a peer must not be able to keep an entry alive.
        this.__cleanup()
        const entry = this.__notificationsData.get(newItem.hashBase64)
        //if data found, update signatures
        if (entry) {
            entry.item.merge(newItem)
            if (entry.item.isVerified) //a majority needs no more signatures, so the entry is no longer pending
                this.__remove(newItem.hashBase64)
            return entry.item
        }
        if (newItem.isVerified) //handed back for adoption without a slot, whatever the sender's quota
            return newItem
        //refused, never evicted: an eviction would let one sender's flood flush another sender's partial entry, which is
        //how a single peer kept this node from reaching a majority. The caller gets the item back uncached.
        if (this.__notificationsData.size >= maxEntries) {
            logger.debug({msg: 'Pending sync data cache is full', sender, hash: newItem.hashBase64})
            return newItem
        }
        const senderEntries = this.__entriesBySender.get(sender) || 0
        if (senderEntries >= maxEntriesPerSender) {
            logger.debug({msg: 'Sender reached its pending sync data quota', sender, hash: newItem.hashBase64})
            return newItem
        }
        this.__entriesBySender.set(sender, senderEntries + 1)
        this.__notificationsData.set(newItem.hashBase64, {item: newItem, receivedAt: Date.now(), sender})
        return newItem
    }

    /**
     * Removes one entry and releases the quota of the node that opened it
     * @param {string} hash - payload hash
     */
    __remove(hash) {
        const entry = this.__notificationsData.get(hash)
        if (!entry)
            return
        this.__notificationsData.delete(hash)
        const senderEntries = this.__entriesBySender.get(entry.sender) || 0
        if (senderEntries <= 1)
            this.__entriesBySender.delete(entry.sender)
        else
            this.__entriesBySender.set(entry.sender, senderEntries - 1)
    }

    __cleanup() {
        const threshold = Date.now() - retentionMs
        for (const [key, entry] of this.__notificationsData)
            if (entry.receivedAt < threshold)
                this.__remove(key)
    }
}

module.exports = PendingSyncDataCache