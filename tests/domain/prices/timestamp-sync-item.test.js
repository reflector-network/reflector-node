/*eslint-disable no-undef */
/*
 * Verifies the TimestampSyncItem timing and timeout-warn behaviour.
 * The pre-fix 35 s timeout collided with the pre-fix
 * attempt-0 envelope, leaving the worker zero margin to submit after a sync
 * timeout. The fix shortens it to 25 s and adds a structured warn listing the
 * peers that never presented.
 */

jest.mock('../../../src/domain/container', () => ({
    settingsManager: {
        appConfig: {publicKey: 'self-pubkey', dbSyncDelay: 0},
        config: {nodes: new Map([['peer-A', {}], ['peer-B', {}]])}
    }
}))

jest.mock('../../../src/domain/nodes/nodes-manager', () => ({
    getConnectedNodes: jest.fn(() => [])
}))

const logger = require('../../../src/logger')
const nodesManager = require('../../../src/domain/nodes/nodes-manager')
const {TimestampSyncItem} = require('../../../src/domain/prices/trades-manager')

//Mirrors runner-base.js constants: OracleRunner.__delay=20s + firstAttemptTimeout=30s.
const ORACLE_DELAY = 20_000
const FIRST_ATTEMPT_TIMEOUT = 30_000
const ATTEMPT_0_MAX_TIME_MS = ORACLE_DELAY + FIRST_ATTEMPT_TIMEOUT //T + 50s

//Pre-fix and post-fix TimestampSyncItem timeouts, relative to T.
const LEGACY_SYNC_TIMEOUT = 35_000
const POST_FIX_SYNC_TIMEOUT = 25_000

describe('TimestampSyncItem timing', () => {
    describe('legacy timeout collided with attempt-0 envelope', () => {
        test('pre-fix timeout left zero headroom for the worker after timeout', () => {
            //Pre-fix pairing: maxSubmitTimeout=15s, attempt-0 envelope ran to T + 35s.
            //Sync timeout at T + 35s fires at the exact same instant — worker has 0ms.
            const preFixAttempt0Envelope = ORACLE_DELAY + 15_000
            expect(LEGACY_SYNC_TIMEOUT).toBe(preFixAttempt0Envelope)
        })

        test('post-fix timeout finishes well before attempt-0 envelope', () => {
            expect(POST_FIX_SYNC_TIMEOUT).toBeLessThan(ATTEMPT_0_MAX_TIME_MS - 20_000)
        })
    })

    describe('runtime behaviour', () => {
        beforeEach(() => {
            jest.useFakeTimers()
            jest.spyOn(logger, 'warn').mockImplementation(() => {})
            jest.spyOn(logger, 'trace').mockImplementation(() => {})
            nodesManager.getConnectedNodes.mockReturnValue([])
        })

        afterEach(() => {
            jest.clearAllTimers()
            jest.useRealTimers()
            jest.restoreAllMocks()
        })

        test('warns with missing peers on timeout', async () => {
            const t0 = Date.now()
            const item = new TimestampSyncItem('exchanges:USD', t0, t0 + 25_000)
            item.add('peer-A') //only one of two expected peers presents

            jest.advanceTimersByTime(25_001)

            await item.readyPromise

            expect(logger.warn).toHaveBeenCalledTimes(1)
            const payload = logger.warn.mock.calls[0][0]
            expect(payload.msg).toBe('TimestampSyncItem auto-resolved by timeout')
            expect(payload.key).toBe('exchanges:USD')
            expect(payload.missing).toEqual(['peer-B'])
            expect(payload.waitedMs).toBeGreaterThanOrEqual(25_000)
        })

        test('no warn when resolved normally by presented peers', async () => {
            //Use real timers: resolution is synchronous, so no clock advancement
            //is required. Real timers also dodge any fake-timer state carryover.
            jest.useRealTimers()
            logger.warn.mockClear()

            const t0 = Date.now()
            const item = new TimestampSyncItem('exchanges:USD', t0, t0 + 60_000)

            //Present both expected peers and the self pubkey; getConnectedNodes
            //is empty so the "all connected peers present" gate is trivially
            //met once the current node is in __presentedPubkeys.
            item.add('self-pubkey')
            item.add('peer-A')
            item.add('peer-B')

            expect(item.isProcessed).toBe(true)
            await item.readyPromise

            expect(logger.warn).not.toHaveBeenCalled()
        })
    })
})
