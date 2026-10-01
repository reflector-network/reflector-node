/*eslint-disable no-undef */
const {getPreciseValue, getVWAP, getMedianPrice} = require('../../src/utils/price-utils')

describe('utils', () => {

    it('get BigInt price', () => {
        const price = 1000n
        const bigIntPrice = getPreciseValue(price, 14)
        expect(bigIntPrice).toBe(100000000000000000n)
    })

    it('get BigInt price for NaN', () => {
        const price = 'Not a number'
        expect(() => getPreciseValue(price, 14)).toThrow('value should be expressed as BigInt')
    })

    it('get BigInt price for NaN decimals', () => {
        const price = 1000n
        expect(() => getPreciseValue(price, 'Not a number')).toThrow('decimals should be expressed as Number')
    })

    it('get VWAP', () => {
        const volume = 1000n
        const quoteVolume = 1000000n
        const vwap = getVWAP(volume, quoteVolume, 8)
        expect(vwap).toBe(100000n)
    })

    it('get VWAP for NaN', () => {
        const volume = 'Not a number'
        const quoteVolume = 1000000n
        expect(() => getVWAP(volume, quoteVolume, 14)).toThrow('volume should be expressed as BigInt')
    })

    it('get VWAP for NaN quote volume', () => {
        const volume = 1000n
        const quoteVolume = 'Not a number'
        expect(() => getVWAP(volume, quoteVolume, 14)).toThrow('quoteVolume should be expressed as BigInt')
    })

    it('get VWAP for zero', () => {
        const volume = 0n
        const quoteVolume = 0n
        expect(getVWAP(volume, quoteVolume, 14)).toBe(0n)
    })

    it('get median price', () => {
        const medianPrice = getMedianPrice([1000000000000000000n, 2000000000000000000n, 3000000000000000000n])
        expect(medianPrice).toBe(2000000000000000000n)
    })

    it('get median price for empty', () => {
        const medianPrice = getMedianPrice([])
        expect(medianPrice).toBe(null)
    })

    it('get median price for zero', () => {
        const medianPrice = getMedianPrice([0n, 0n, 0n])
        expect(medianPrice).toBe(null)
    })

    it('get median price for single', () => {
        const medianPrice = getMedianPrice([1000000000000000000n])
        expect(medianPrice).toBe(1000000000000000000n)
    })

    it('get median price for odd', () => {
        const testCasses = [
            {data: [970n, 1010n, 1000n, 1015n, 1020n], result: 1010n},
            {data: [970n, 1100n, 1000n, 1080n, 1020n], result: 1010n},
            {data: [1000n, 1000n, 1000n, 1000n, 1000n], result: 1000n}
        ]
        for (const testCase of testCasses) {
            const medianPrice = getMedianPrice(testCase.data)
            expect(medianPrice).toBe(testCase.result)
        }
    })

    it('get median price for even', () => {
        const testCasses = [
            {data: [970n, 1010n, 1000n, 1015n, 1020n, 980n], result: 1005n},
            {data: [970n, 1100n, 1000n, 1080n, 1020n, 980n], result: 990n},
            {data: [1000n, 1000n, 1000n, 1000n, 1000n, 1000n], result: 1000n}
        ]
        for (const testCase of testCasses) {
            const medianPrice = getMedianPrice(testCase.data)
            expect(medianPrice).toBe(testCase.result)
        }
    })

    it('get median price for even with single non-zero', () => {
        const medianPrice = getMedianPrice([0n, 0n, 1000000000000000000n, 0n])
        expect(medianPrice).toBe(1000000000000000000n)
    })

    it('get median price for even with null and undefined', () => {
        const medianPrice = getMedianPrice([970n, 1010n, 1000n, null, undefined, 0n])
        expect(medianPrice).toBe(1000n)
    })
})

describe('withDeadline', () => {
    const {withDeadline} = require('../../src/utils/utils')

    it('resolves when the promise settles in time', async () => {
        await expect(withDeadline(Promise.resolve('ok'), 1000, 'too slow')).resolves.toBe('ok')
    })

    it('rejects with the given message when the promise never settles', async () => {
        await expect(withDeadline(new Promise(() => {}), 20, 'too slow')).rejects.toThrow('too slow')
    })

    it('rejects immediately when there is no budget left', async () => {
        await expect(withDeadline(new Promise(() => {}), 0, 'no budget')).rejects.toThrow('no budget')
    })

    it('propagates the original rejection', async () => {
        await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'too slow')).rejects.toThrow('boom')
    })

    it('does not leave a late rejection unhandled', async () => {
        let fail
        const late = new Promise((_, reject) => {
            fail = reject
        })
        await expect(withDeadline(late, 20, 'too slow')).rejects.toThrow('too slow')
        fail(new Error('late failure'))
        await new Promise(resolve => setTimeout(resolve, 10))
    })

    it.each([
        ['zero', 0],
        ['negative', -5],
        ['not a number', NaN]
    ])('rejects a %s budget at once, without arming a timer', async (label, budget) => {
        jest.useFakeTimers()
        try {
            //a build deadline computed from an envelope that has already closed comes out zero or negative
            const attempt = withDeadline(new Promise(() => {}), budget, 'no budget')
            expect(jest.getTimerCount()).toBe(0)
            await expect(attempt).rejects.toThrow('no budget')
        } finally {
            jest.useRealTimers()
        }
    })

    it.each([
        ['resolves', () => Promise.resolve('ok')],
        ['rejects', () => Promise.reject(new Error('boom'))]
    ])('leaves no timer behind when the promise %s before the deadline', async (label, settle) => {
        jest.useFakeTimers()
        try {
            await withDeadline(settle(), 20_000, 'too slow').catch(() => {})
            //a live deadline timer would hold a clean process exit for up to the whole budget
            expect(jest.getTimerCount()).toBe(0)
        } finally {
            jest.useRealTimers()
        }
    })

    it('treats a plain value as an already settled promise', async () => {
        await expect(withDeadline('ok', 1000, 'too slow')).resolves.toBe('ok')
    })

    it('handles a late rejection of the bounded promise even when there was no budget to race it against', () => {
        //jest does not fail a test on an unhandled rejection, so this runs where one ends the process
        const {execFileSync} = require('child_process')
        const utilsPath = require.resolve('../../src/utils/utils')
        const script = `
            const {withDeadline} = require(${JSON.stringify(utilsPath)})
            let fail
            const late = new Promise((_, reject) => { fail = reject })
            withDeadline(late, 0, 'no budget').catch(() => {})
            setTimeout(() => fail(new Error('late failure')), 5)
            setTimeout(() => process.stdout.write('survived'), 50)
        `
        expect(execFileSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {encoding: 'utf8', stdio: 'pipe'})).toBe('survived')
    })
})
