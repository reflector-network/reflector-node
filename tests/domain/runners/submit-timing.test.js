/*eslint-disable no-undef */
/*
 * The tests are pure-math assertions against the constants in
 * src/domain/runners/runner-base.js and src/domain/runners/oracle-runner.js —
 * they do not exercise the network, but they mechanically reproduce the
 * `sendTransaction <-> maxTime` race that produced the txTooLate errors.
 */

//legacy single-knob model (pre-fix). retained to demonstrate the bug.
const LEGACY_MAX_SUBMIT_TIMEOUT = 15000 //value after cc008e6 that caused the incident

//post-fix decoupled model.
const FIRST_ATTEMPT_TIMEOUT = 30000
const RETRY_ATTEMPT_TIMEOUT = 15000
const MAX_SUBMIT_ATTEMPTS = 3
const ORACLE_SYNC_DELAY = 20000

/**
 * Legacy (pre-fix) getMaxTime: single knob times iteration.
 * @param {number} syncTimestampMs - syncTimestamp in ms
 * @param {number} iteration - 1-based iteration
 * @param {number} maxSubmitTimeout - legacy single-knob timeout in ms
 * @returns {number} - maxTime in Stellar envelope seconds
 */
function getMaxTimeLegacy(syncTimestampMs, iteration, maxSubmitTimeout) {
    return (syncTimestampMs + maxSubmitTimeout * iteration) / 1000
}

/**
 * Current (post-fix) getMaxTime: decoupled first-attempt and retry budgets.
 * Mirrors getMaxTime in src/domain/runners/runner-base.js.
 * @param {number} syncTimestampMs - syncTimestamp in ms
 * @param {number} iteration - 1-based iteration (attempt 0 = iteration 1)
 * @returns {number} - maxTime in Stellar envelope seconds
 */
function getMaxTime(syncTimestampMs, iteration) {
    const budget = FIRST_ATTEMPT_TIMEOUT + RETRY_ATTEMPT_TIMEOUT * (iteration - 1)
    return (syncTimestampMs + budget) / 1000
}

/**
 * Budget the submission path must fit into on attempt N.
 * Models the time remaining between `submitTransaction` entry and tx maxTime.
 *
 * @param {Object} opts - submit-path timing inputs
 * @param {number} opts.attempt - 0-indexed attempt number (kept for call-site clarity)
 * @param {number} opts.workerStartLagMs - how late after T+__delay the worker actually started
 * @param {number} opts.workerFnMs - time spent in OracleRunner.__workerFn before buildTx
 * @param {number} opts.buildTxMs - time to build+simulate the tx
 * @param {number} opts.signatureLatencyMs - time until majority peer signatures arrive
 * @param {number} opts.jitterMs - random 0..1000 ms sleep before submitTransaction
 * @param {number} opts.rpcRoundTripMs - getTransaction + sendTransaction RPC time
 * @param {number} opts.attemptBudgetMs - per-attempt envelope budget in ms (legacy or first-attempt)
 * @param {number} opts.syncDelay - OracleRunner.__delay
 * @returns {number} ms remaining on the envelope when submitTransaction enters
 */
function timeRemainingBeforeMaxTime(opts) {
    const {
        workerStartLagMs,
        workerFnMs,
        buildTxMs,
        signatureLatencyMs,
        jitterMs,
        rpcRoundTripMs,
        attemptBudgetMs,
        syncDelay
    } = opts

    //Wall time relative to T (the timeframe boundary)
    const workerStart = syncDelay + workerStartLagMs
    const buildStart = workerStart + workerFnMs
    const buildEnd = buildStart + buildTxMs
    //signature collection starts at buildEnd (when __setPendingTransaction broadcasts own sig)
    const majorityReached = buildEnd + signatureLatencyMs
    const submitStart = majorityReached + jitterMs + rpcRoundTripMs
    //attempt N maxTime, expressed in ms from T
    const maxTimeMs = syncDelay + attemptBudgetMs
    return maxTimeMs - submitStart
}

describe('Submit-timing budget', () => {
    //Observed signature-collection latencies from the incident (ms from build to majority):
    //17:00 worker (peer sigs at +2.7s, +9.5s, +10.9s);
    //17:10 worker completed normally at < 1000 ms.
    const latencyObserved17_00 = 10862
    const latencyFastNormal = 1000

    describe('legacy 15s attempt-0 budget (reproduces the incident)', () => {
        test('fast cluster: tx still submits well before maxTime', () => {
            const remaining = timeRemainingBeforeMaxTime({
                attempt: 0,
                workerStartLagMs: 500,
                workerFnMs: 500,
                buildTxMs: 250,
                signatureLatencyMs: latencyFastNormal,
                jitterMs: 500,
                rpcRoundTripMs: 400,
                attemptBudgetMs: LEGACY_MAX_SUBMIT_TIMEOUT,
                syncDelay: ORACLE_SYNC_DELAY
            })
            //Stellar lookahead ~5s; safe if remaining >= 6000
            expect(remaining).toBeGreaterThan(6000)
        })

        test('observed 17:00 latency: tx lands in txTooLate danger zone', () => {
            const remaining = timeRemainingBeforeMaxTime({
                attempt: 0,
                workerStartLagMs: 1306,
                workerFnMs: 500,
                buildTxMs: 250,
                signatureLatencyMs: latencyObserved17_00,
                jitterMs: 500,
                rpcRoundTripMs: 400,
                attemptBudgetMs: LEGACY_MAX_SUBMIT_TIMEOUT,
                syncDelay: ORACLE_SYNC_DELAY
            })
            //sendTransaction happened ~1.8s before maxTime — Stellar rejects.
            expect(remaining).toBeLessThan(2500)
            //below the ~5s Stellar ledger-close lookahead buffer where txTooLate becomes likely.
            expect(remaining).toBeLessThan(5000)
        })
    })

    describe('post-fix 30s attempt-0 budget', () => {
        test('same latency now has safe margin', () => {
            const remaining = timeRemainingBeforeMaxTime({
                attempt: 0,
                workerStartLagMs: 1306,
                workerFnMs: 500,
                buildTxMs: 250,
                signatureLatencyMs: latencyObserved17_00,
                jitterMs: 500,
                rpcRoundTripMs: 400,
                attemptBudgetMs: FIRST_ATTEMPT_TIMEOUT,
                syncDelay: ORACLE_SYNC_DELAY
            })
            //+15s over the legacy constant moves this well past the lookahead buffer.
            expect(remaining).toBeGreaterThan(16000)
        })
    })

    describe('retries under the new split model', () => {
        test('attempt 1 uses retry budget stacked on the first-attempt window', () => {
            const syncTimestamp = 1_000_000
            const maxTimeSec = getMaxTime(syncTimestamp, 2)
            expect(maxTimeSec).toBe((syncTimestamp + 45000) / 1000)
        })

        test('attempt 2 uses two retry budgets', () => {
            const syncTimestamp = 1_000_000
            const maxTimeSec = getMaxTime(syncTimestamp, 3)
            expect(maxTimeSec).toBe((syncTimestamp + 60000) / 1000)
        })

        test('legacy model coupled retry spacing to attempt budget (contrast)', () => {
            //pre-fix getMaxTime(ts, 2, 15000) returned ts + 30_000; doubling the
            //legacy constant would have also doubled retry spacing.
            const syncTimestamp = 1_000_000
            expect(getMaxTimeLegacy(syncTimestamp, 2, LEGACY_MAX_SUBMIT_TIMEOUT))
                .toBe((syncTimestamp + 30000) / 1000)
        })
    })

    describe('fee escalation', () => {
        /**
         * @param {number} baseFee - base fee in stroops
         * @param {number} attempt - 0-indexed attempt
         * @returns {number} stellar fee for that attempt
         */
        const feeOf = (baseFee, attempt) => baseFee * Math.pow(8, attempt)

        test('escalates 8x per attempt (was 4x pre-fix)', () => {
            expect(feeOf(100, 0)).toBe(100)
            expect(feeOf(100, 1)).toBe(800)
            expect(feeOf(100, 2)).toBe(6400)
        })
    })

    describe('constants currently in runner-base.js', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../../src/domain/runners/runner-base.js'),
            'utf8'
        )

        test('firstAttemptTimeout is 30000', () => {
            const match = src.match(/const firstAttemptTimeout = (\d[\d_]*)/)
            expect(match).not.toBeNull()
            expect(Number(match[1].replace(/_/g, ''))).toBe(FIRST_ATTEMPT_TIMEOUT)
        })

        test('retryAttemptTimeout is 15000', () => {
            const match = src.match(/const retryAttemptTimeout = (\d[\d_]*)/)
            expect(match).not.toBeNull()
            expect(Number(match[1].replace(/_/g, ''))).toBe(RETRY_ATTEMPT_TIMEOUT)
        })

        test('maxSubmitAttempts is 3', () => {
            const match = src.match(/const maxSubmitAttempts = (\d+)/)
            expect(match).not.toBeNull()
            expect(Number(match[1])).toBe(MAX_SUBMIT_ATTEMPTS)
        })

        test('fee escalation base is 8', () => {
            const match = src.match(/Math\.pow\((\d+),\s*submitAttempt\)/)
            expect(match).not.toBeNull()
            expect(Number(match[1])).toBe(8)
        })

        test('legacy single-knob constant is gone', () => {
            expect(src).not.toMatch(/const maxSubmitTimeout\s*=/)
        })
    })
})
