const logger = require('../../logger')

const minute = 60 * 1000
const message = 'Nodes absent from or disagreeing with majority-agreed trades samples'
//one warning per (source, base, kind, member) at most this often while that member keeps dissenting that way
const warnInterval = 10 * minute
//how often members that stopped dissenting are looked for, so their folded calls get reported
const sweepInterval = minute
//A node reads a handful of (source, base) pairs, a cluster has at most 20 members (the Stellar signer limit), and a
//member dissents in one of three ways: 8 pairs x 20 members x 3 kinds is 480. Only a local config with far more pairs
//fills it; past the bound a new entry replaces one whose interval has passed, or is only counted.
const maxTrackedEntries = 2048
const kinds = ['missing', 'mismatched', 'equivocating']

/**
 * @typedef {Object} DissentRecord
 * @property {string} source - data source of the computation
 * @property {string} base - base asset code of the computation
 * @property {string[]} missing - members holding no sample for a trade source of an agreed sample, sorted by code unit
 * @property {string[]} mismatched - members holding a different sample for that trade source, sorted by code unit
 * @property {string[]} equivocating - members reporting more than one sample for one trade source, sorted by code unit
 * @property {string} self - pubkey of this node
 */

/**
 * @typedef {Object} DissentEntry
 * @property {string} source - data source
 * @property {string} base - base asset code
 * @property {string} kind - missing, mismatched or equivocating
 * @property {string} node - the dissenting member
 * @property {boolean} selfDissented - whether the member is this node
 * @property {number} warnedAt - when the last warning for the entry went out
 * @property {number} lastSeenAt - when the member last dissented this way
 * @property {number} suppressed - calls since the last warning that went to debug only
 */

/**
 * @param {DissentEntry} entry - entry to warn about, with the calls it folded since its last warning
 * @param {boolean} final - whether this is the last line for the entry: the member stopped dissenting that way, or the
 * entry was evicted, so a later line for it starts over
 */
function warn({source, base, kind, node, selfDissented, suppressed}, final) {
    //suppressed: calls since the previous warning for this member and kind that went to debug only
    logger.warn({msg: message, source, base, kind, node, selfDissented, suppressed, final})
}

/**
 * Rate limit for the dissent record of getConcensusData. Every call that sees dissent logs its whole
 * record at debug. Warnings are per (source, base, kind, member): a member warns when it starts dissenting that way
 * and then at most once per interval while it keeps doing so, carrying how many calls it folded. A per-call record
 * cannot be the key: every subscription on a source shares one pair and prices one asset, so a member dissenting on
 * some assets only would change the record from call to call and defeat any per-record limit. A member that stops
 * dissenting reports what it folded once its interval has passed, in a line marked `final`.
 *
 * The map holds at most maxTrackedEntries entries, ordered by their last warning. A new entry arriving at a full map
 * takes the place of the least recently warned one only if that one's interval has passed, so every slot still warns
 * at most once per interval; otherwise the new sighting is only counted, and the count goes out at most once per
 * interval in an `overflow` line. An over-cap workload therefore stays throttled instead of warning on every sighting.
 *
 * This is log-only state. It reads the wall clock and keeps module-level state, which consensus code must not do, and
 * that is safe only because nothing here reaches a price vector or a transaction.
 */
class DissentLog {
    /**
     * Entries in the order of their last warning, least recent first: every warning moves its entry to the end.
     * @type {Map<string, DissentEntry>}
     */
    __entries = new Map()

    __sweptAt = -Infinity

    /**
     * Sightings the full map could not track since the last overflow line
     */
    __overflow = 0

    __overflowWarnedAt = -Infinity

    /**
     * @param {DissentRecord} record - the dissent observed by one call
     * @param {number} [now] - wall clock, injectable for tests
     * @returns {number} warnings this call emitted for its own record
     */
    report({source, base, missing = [], mismatched = [], equivocating = [], self}, now = Date.now()) {
        const lists = {missing, mismatched, equivocating}
        let warned = 0
        if (missing.length + mismatched.length + equivocating.length > 0) {
            const selfDissented = missing.includes(self) || mismatched.includes(self) || equivocating.includes(self)
            logger.debug({msg: message, source, base, missing, mismatched, equivocating, selfDissented})
            for (const kind of kinds)
                for (const node of lists[kind])
                    if (this.__observe(source, base, kind, node, node === self, now))
                        warned++
        }
        if (now - this.__sweptAt >= sweepInterval)
            this.__sweep(now)
        return warned
    }

    /**
     * Forgets every entry. Nothing but tests needs this: the state is bounded on its own.
     */
    clear() {
        this.__entries.clear()
        this.__sweptAt = -Infinity
        this.__overflow = 0
        this.__overflowWarnedAt = -Infinity
    }

    /**
     * @returns {number} entries currently tracked
     */
    get size() {
        return this.__entries.size
    }

    /**
     * @param {string} source - data source
     * @param {string} base - base asset code
     * @param {string} kind - missing, mismatched or equivocating
     * @param {string} node - the dissenting member
     * @param {boolean} selfDissented - whether the member is this node
     * @param {number} now - wall clock
     * @returns {boolean} whether a warning went out
     */
    __observe(source, base, kind, node, selfDissented, now) {
        const entryKey = `${source.length}:${source}|${base.length}:${base}|${kind}|${node}`
        let entry = this.__entries.get(entryKey)
        if (entry) {
            entry.lastSeenAt = now
            if (now - entry.warnedAt < warnInterval) {
                entry.suppressed++
                return false
            }
            this.__entries.delete(entryKey) //re-inserted below, at the most recently warned end
        } else {
            if (this.__entries.size >= maxTrackedEntries && !this.__evictLeastRecentlyWarned(now)) {
                this.__countOverflow(now)
                return false
            }
            entry = {source, base, kind, node, selfDissented, warnedAt: now, lastSeenAt: now, suppressed: 0}
        }
        warn(entry, false)
        entry.warnedAt = now
        entry.suppressed = 0
        this.__entries.set(entryKey, entry)
        return true
    }

    /**
     * Frees a slot by evicting the least recently warned entry, but only if its interval has passed - it would warn
     * again on its next sighting anyway, so the slot still warns at most once per interval.
     * @param {number} now - wall clock
     * @returns {boolean} whether a slot was freed
     */
    __evictLeastRecentlyWarned(now) {
        const [oldestKey, oldest] = this.__entries.entries().next().value
        if (now - oldest.warnedAt < warnInterval)
            return false
        this.__drop(oldestKey, oldest)
        return true
    }

    /**
     * @param {number} now - wall clock
     */
    __countOverflow(now) {
        this.__overflow++
        this.__reportOverflow(now)
    }

    /**
     * Reports the untracked sightings, at most once per interval
     * @param {number} now - wall clock
     */
    __reportOverflow(now) {
        if (this.__overflow === 0 || now - this.__overflowWarnedAt < warnInterval)
            return
        //overflow: sightings of members the full map could not track since the previous overflow line
        logger.warn({msg: message, overflow: this.__overflow, tracked: this.__entries.size})
        this.__overflow = 0
        this.__overflowWarnedAt = now
    }

    /**
     * Drops every member that has not dissented that way for a whole interval; one that folded calls reports them.
     * @param {number} now - wall clock
     */
    __sweep(now) {
        this.__sweptAt = now
        for (const [entryKey, entry] of this.__entries)
            if (now - entry.lastSeenAt >= warnInterval)
                this.__drop(entryKey, entry)
        this.__reportOverflow(now)
    }

    /**
     * @param {string} entryKey - key of the entry
     * @param {DissentEntry} entry - the entry
     */
    __drop(entryKey, entry) {
        this.__entries.delete(entryKey)
        if (entry.suppressed > 0)
            warn(entry, true)
    }
}

module.exports = {DissentLog, dissentLog: new DissentLog(), maxTrackedEntries, warnInterval}
