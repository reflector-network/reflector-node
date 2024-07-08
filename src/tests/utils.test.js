/*eslint-disable no-undef */
const {getPreciseValue, getVWAP, getMedianPrice} = require('../utils/price-utils')

describe('utils', () => {

    it('get BigInt price', () => {
        const price = 1000n
        const bigIntPrice = getPreciseValue(price, 14)
        expect(bigIntPrice).toBe(100000000000000000n)
    })

    it('get BigInt price for NaN', () => {
        const price = 'Not a number'
        expect(() => getPreciseValue(price, 14)).toThrowError('Value should be expressed as BigInt')
    })

    it('get BigInt price for NaN decimals', () => {
        const price = 1000n
        expect(() => getPreciseValue(price, 'Not a number')).toThrowError('Decimals should be expressed as Number')
    })

    it('get VWAP', () => {
        const volume = 1000n
        const quoteVolume = 1000000n
        const vwap = getVWAP(volume, quoteVolume, 8)
        expect(vwap).toBe(100000000000n)
    })

    it('get VWAP for NaN', () => {
        const volume = 'Not a number'
        const quoteVolume = 1000000n
        expect(() => getVWAP(volume, quoteVolume, 14)).toThrowError('Value should be expressed as BigInt')
    })

    it('get VWAP for NaN quote volume', () => {
        const volume = 1000n
        const quoteVolume = 'Not a number'
        expect(() => getVWAP(volume, quoteVolume, 14)).toThrowError('Value should be expressed as BigInt')
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