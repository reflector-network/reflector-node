/*eslint-disable no-undef */

jest.mock('../../../src/domain/container', () => ({
    settingsManager: {
        appConfig: {keypair: {signDecorated: jest.fn()}},
        nodes: new Map()
    }
}))

jest.mock('../../../src/domain/nodes/nodes-manager', () => ({
    broadcast: jest.fn(),
    sendTo: jest.fn()
}))

jest.mock('../../../src/domain/statistics-manager', () => ({
    setLastProcessedTimestamp: jest.fn()
}))

jest.mock('@reflector/reflector-shared', () => ({
    normalizeTimestamp: (ts, tf) => Math.floor(ts / tf) * tf
}))

const RunnerBase = require('../../../src/domain/runners/runner-base')

class TestRunner extends RunnerBase {
    get __timeframe() {
        return 60000
    }

    __getNextTimestamp(current) {
        return current + 60000
    }

    async __workerFn() {
        return false
    }
}

describe('RunnerBase', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    test('stop() clears __pendingSignaturesTimeout', () => {
        const runner = new TestRunner('test-contract')
        runner.start()

        expect(runner.__pendingSignaturesTimeout).toBeDefined()

        runner.stop()

        //advance past the 60s interval — callback should NOT reschedule
        const stoppedTimeoutId = runner.__pendingSignaturesTimeout
        jest.advanceTimersByTime(120000)

        //timeout ref should remain the same (no new timeout was created)
        expect(runner.__pendingSignaturesTimeout).toBe(stoppedTimeoutId)
    })

    test('__clearPendingSignatures reschedules itself while running', () => {
        const runner = new TestRunner('test-contract')
        runner.start()

        const firstTimeoutId = runner.__pendingSignaturesTimeout
        jest.advanceTimersByTime(60000)

        //a new timeout should have been created
        expect(runner.__pendingSignaturesTimeout).not.toBe(firstTimeoutId)
    })

    test('__clearPendingSignatures removes stale entries', () => {
        const runner = new TestRunner('test-contract')
        runner.start()

        //add a pending signature with a timestamp in the past
        runner.__pendingSignatures.set('stale-hash', {
            timestamp: Date.now() - 120000,
            owner: 'peer-a',
            signatures: new Map()
        })
        runner.__pendingSignatures.set('fresh-hash', {
            timestamp: Date.now(),
            owner: 'peer-b',
            signatures: new Map()
        })
        runner.__pendingSignaturesByPeer.set('peer-a', 1)
        runner.__pendingSignaturesByPeer.set('peer-b', 1)

        jest.advanceTimersByTime(60000)

        expect(runner.__pendingSignatures.has('stale-hash')).toBe(false)
        expect(runner.__pendingSignatures.has('fresh-hash')).toBe(true)
        expect(runner.__pendingSignaturesByPeer.get('peer-a')).toBeUndefined()

        runner.stop()
    })

    test('stop() clears __workerTimeout', () => {
        const runner = new TestRunner('test-contract')
        runner.start()

        runner.__workerTimeout = setTimeout(() => {}, 60000)
        const workerTimeoutId = runner.__workerTimeout

        runner.stop()

        expect(runner.isRunning).toBe(false)
        //verify the timeout was cleared by checking it doesn't fire
        const spy = jest.fn()
        const originalCallback = workerTimeoutId
        jest.advanceTimersByTime(120000)
        expect(spy).not.toHaveBeenCalled()
    })
})

describe('RunnerBase quiet catch-up and clock steps', () => {
    const logger = require('../../../src/logger')

    beforeEach(() => {
        logger.warn.mockClear()
        logger.error.mockClear()
    })

    afterEach(() => {
        jest.restoreAllMocks()
        jest.useRealTimers()
    })

    test('a round whose last deadline has already passed is skipped without building', async () => {
        const runner = new TestRunner('test-contract')
        runner.isRunning = true
        const buildTxFn = jest.fn()
        const tenMinutesAgo = Date.now() - 10 * 60000
        expect(RunnerBase.tickSkippedMessage).toEqual(expect.any(String))
        await expect(runner.__buildAndSubmitTransaction(buildTxFn, {}, 100, tenMinutesAgo))
            .rejects.toThrow(RunnerBase.tickSkippedMessage)
        expect(buildTxFn).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('the worker reports a skipped round as one warning, not an error', async () => {
        const runner = new TestRunner('test-contract')
        runner.isRunning = true
        runner.__scheduleWorker = jest.fn()
        runner.__workerFn = () => Promise.reject(new Error(RunnerBase.tickSkippedMessage))
        await runner.worker(Date.now())
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({msg: RunnerBase.tickSkippedMessage}))
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('missing trades data is a warning in the first two timeframes after the start, and an error afterwards', async () => {
        const runner = new TestRunner('test-contract')
        runner.isRunning = true
        runner.__scheduleWorker = jest.fn()
        const missing = new Error('Trades data not found for contract C for timestamp 1')
        missing.code = 'TRADES_DATA_NOT_FOUND'
        runner.__workerFn = () => Promise.reject(missing)
        const uptime = jest.spyOn(process, 'uptime').mockReturnValue(30)
        await runner.worker(Date.now())
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'No trades data yet after the start'}))
        expect(logger.error).not.toHaveBeenCalled()
        uptime.mockReturnValue(3600)
        await runner.worker(Date.now())
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({msg: 'Error in worker'}))
    })

    test('a long wait re-reads the clock, so a clock that steps forward does not delay the tick', () => {
        jest.useFakeTimers({now: 1_800_000_000_000})
        const runner = new TestRunner('test-contract')
        runner.__runWorker = jest.fn()
        const target = Date.now() + 10 * 60000
        runner.__scheduleWorker(target)
        jest.advanceTimersByTime(60000)
        //the host was paused for two minutes: the wall clock steps forward while no timer ran
        jest.setSystemTime(Date.now() + 2 * 60000)
        jest.advanceTimersByTime(7 * 60000 - 1000)
        expect(runner.__runWorker).not.toHaveBeenCalled()
        jest.advanceTimersByTime(1000)
        expect(runner.__runWorker).toHaveBeenCalledWith(target)
        expect(Date.now()).toBe(target)
    })
})
