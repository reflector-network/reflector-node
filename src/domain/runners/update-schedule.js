//The switch rule and the submit schedule of a cluster update. reflector-node (src/domain/runners/update-schedule.js) and
//node-orchestrator (domain/update-schedule.js) keep byte-identical copies of this file: the nodes build the update
//transaction with these values and the orchestrator derives the same hash from them to confirm that it landed, so a
//change to one copy must be made to the other in the same release. reflector-node
//tests/cross-repo/update-schedule-parity.test.js compares the two. The module has no dependencies so that test can load
//it from the sibling checkout
const FEE_MULTIPLIER = 8
const firstAttemptTimeout = 30_000
const retryAttemptTimeout = 15_000
const maxSubmitAttempts = 3
//the sync grid: the orchestrator puts every switch time on it, and both sides retry a failed round at its next tick
const syncTimeframe = 120_000

/**
 * @param {number} syncTimestamp - sync timestamp in milliseconds
 * @param {number} iteration - 1-based iteration (attempt 0 → iteration 1)
 * @returns {number} - max time in seconds
 */
function __getMaxTime(syncTimestamp, iteration) {
    const budgetMs = firstAttemptTimeout + retryAttemptTimeout * (iteration - 1)
    return (syncTimestamp + budgetMs) / 1000
}

/**
 * Whether a scheduled update is due at a sync tick. Inclusive: the tick equal to the switch time builds the update
 * @param {number} pendingTimestamp - switch time of the scheduled update, milliseconds
 * @param {number} syncTimestamp - the sync tick, milliseconds
 * @returns {boolean}
 */
function isUpdateTimeReached(pendingTimestamp, syncTimestamp) {
    return pendingTimestamp <= syncTimestamp
}

/**
 * Whether a round started at a sync tick is over before the proposal expires: its last attempt's maxTime, and the
 * orchestrator's poll a second past it. The orchestrator requires it of the switch time when an update turns PENDING, and
 * a node requires it of every round it builds, so no round is still running when the orchestrator rejects the update at
 * its expiration date. A pure function of its arguments: it reads no clock
 * @param {number} syncTimestamp - the tick the round starts at, milliseconds
 * @param {number} expirationDate - expiration date of the proposal, milliseconds
 * @returns {boolean}
 */
function endsBeforeExpiration(syncTimestamp, expirationDate) {
    return __getMaxTime(syncTimestamp, maxSubmitAttempts) * 1000 + 1000 <= expirationDate
}

module.exports = {
    FEE_MULTIPLIER,
    firstAttemptTimeout,
    retryAttemptTimeout,
    maxSubmitAttempts,
    syncTimeframe,
    __getMaxTime,
    isUpdateTimeReached,
    endsBeforeExpiration
}
