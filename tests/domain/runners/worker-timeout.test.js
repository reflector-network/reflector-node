/*eslint-disable no-undef, class-methods-use-this */
jest.mock('../../../src/domain/container', () => ({settingsManager: {appConfig: {keypair: {signDecorated: jest.fn()}}, nodes: new Map()}}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn()}))
jest.mock('@reflector/reflector-shared', () => ({normalizeTimestamp: (ts, tf) => Math.floor(ts / tf) * tf}))

const logger = require('../../../src/logger')
const RunnerBase = require('../../../src/domain/runners/runner-base')

class NaNDelayRunner extends RunnerBase {
    get __timeframe() {
        return 60000
    }

    get __delay() {
        return undefined //a subclass delay that reads a missing config field
    }

    __getNextTimestamp(current) {
        return current + 60000
    }

    __workerFn() {
        return Promise.resolve(false)
    }
}

class NormalRunner extends NaNDelayRunner {
    get __delay() {
        return 20000
    }
}

describe('RunnerBase worker timeout', () => {
    let nowSpy

    beforeEach(() => {
        //the clock is read inside __getWorkerTimeout, so pin it rather than calling Date.now() in the test too
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        logger.error.mockClear()
    })

    afterEach(() => {
        nowSpy.mockRestore()
    })

    test('a non-finite delay falls back to one timeframe instead of a 1 ms busy loop', () => {
        const runner = new NaNDelayRunner('c1')

        const timeout = runner.__getWorkerTimeout(1_005_000)

        expect(Number.isFinite(timeout)).toBe(true)
        expect(timeout).toBe(60000)
        expect(logger.error).toHaveBeenCalledTimes(1)
    })

    test('a non-finite timestamp falls back to one timeframe too', () => {
        const runner = new NormalRunner('c3')

        expect(runner.__getWorkerTimeout(NaN)).toBe(60000)
        expect(runner.__getWorkerTimeout(Infinity)).toBe(60000)
    })

    test('a finite delay is returned unchanged', () => {
        const runner = new NormalRunner('c2')

        expect(runner.__getWorkerTimeout(1_005_000)).toBe(25000)
        //a tick already overdue stays negative here; the call sites clamp it to 1 ms, which is the intended catch-up
        expect(runner.__getWorkerTimeout(900_000)).toBe(-80000)
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('start() arms the first tick one timeframe out when the delay is missing', () => {
        jest.useFakeTimers({now: 1_000_000})
        try {
            const spy = jest.spyOn(global, 'setTimeout')
            const runner = new NaNDelayRunner('c4')
            runner.__clearPendingSignatures = jest.fn()

            runner.start()

            expect(spy).toHaveBeenCalledTimes(1)
            expect(spy.mock.calls[0][1]).toBe(60000)
            runner.stop()
        } finally {
            jest.clearAllTimers()
            jest.useRealTimers()
        }
    })
})
