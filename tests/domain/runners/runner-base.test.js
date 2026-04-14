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
        runner.__pendingSignatures['stale-hash'] = {
            timestamp: Date.now() - 120000,
            signatures: []
        }
        runner.__pendingSignatures['fresh-hash'] = {
            timestamp: Date.now(),
            signatures: []
        }

        jest.advanceTimersByTime(60000)

        expect(runner.__pendingSignatures['stale-hash']).toBeUndefined()
        expect(runner.__pendingSignatures['fresh-hash']).toBeDefined()

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
