/*eslint-disable no-undef */
const {until, gridCeil, short} = require('./wait')

describe('until', () => {
    test('returns the first truthy value', async () => {
        let n = 0
        await expect(until(() => ++n === 3 && 'done', {timeout: 1000, every: 5})).resolves.toBe('done')
    })

    test('times out naming the condition and the last error', async () => {
        await expect(until(() => {
            throw new Error('not yet')
        }, {timeout: 30, every: 5, describe: 'the thing'})).rejects.toThrow(/Timed out after \d+ s waiting for the thing: not yet/)
    })

    test('stops when cancelled', async () => {
        await expect(until(() => false, {timeout: 5000, every: 5, isCancelled: () => true})).rejects.toThrow('Cancelled')
    })
})

test('gridCeil rounds up to the two-minute grid and keeps a grid time', () => {
    expect(gridCeil(1_800_000_000_001)).toBe(1_800_000_120_000)
    expect(gridCeil(1_800_000_000_000)).toBe(1_800_000_000_000)
})

test('short keeps eight characters', () => {
    expect(short('GABCDEFGHIJK')).toBe('GABCDEFG')
    expect(short(null)).toBe('null')
})

describe('cancellableSleep', () => {
    const {cancellableSleep} = require('./wait')

    test('waits the full time when not cancelled', async () => {
        const started = Date.now()
        await cancellableSleep(40, () => false, 10)
        expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    })

    test('stops early with Cancelled once cancellation is requested', async () => {
        let cancelled = false
        setTimeout(() => {
            cancelled = true
        }, 20)
        const started = Date.now()
        await expect(cancellableSleep(5000, () => cancelled, 10)).rejects.toThrow('Cancelled')
        expect(Date.now() - started).toBeLessThan(1000)
    })
})
