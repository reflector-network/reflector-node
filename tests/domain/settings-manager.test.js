/*eslint-disable no-undef */
jest.mock('../../src/domain/data-sources-manager', () => ({
    setGateways: jest.fn(),
    setDataSources: jest.fn(),
    dispose: jest.fn(),
    get: jest.fn(),
    has: jest.fn(() => true),
    issues: []
}))

const SettingsManager = require('../../src/domain/settings-manager')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const TICK = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
//the contract's own never-expires marker: 3000-01-01T00:00:00Z in milliseconds (timestamps::DISTANT_FUTURE)
const DISTANT_FUTURE = 32_503_680_000_000n

/**
 * @param {Array<{code: string}>} assets - contract assets
 * @returns {SettingsManager} a manager with a single oracle contract and no expiration recorded
 */
function makeManager(assets) {
    const manager = new SettingsManager()
    manager.config = {contracts: new Map([[CONTRACT_ID, {contractId: CONTRACT_ID, assets}]])}
    return manager
}

describe('SettingsManager.getAssets', () => {
    const assets = [{code: 'BTC'}, {code: 'ETH'}, {code: 'XLM'}]

    test('with no expiration recorded every asset is active', () => {
        const manager = makeManager(assets)
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual(assets)
    })

    test('an explicit zero is a feed nobody has paid for, so it is null', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [0n, 0n, 0n])
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual([null, null, null])
    })

    test('an unpaid beam feed stays unpublished next to a paid one', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [0n, BigInt(TICK + DAY), 0n])
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual([null, assets[1], null])
    })

    test('the contract never-expires marker is active', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [DISTANT_FUTURE, DISTANT_FUTURE, DISTANT_FUTURE])
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual(assets)
    })

    test('an asset whose expiration is below the tick timestamp is null', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [BigInt(TICK + 1000), BigInt(TICK - 1000), DISTANT_FUTURE])
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual([assets[0], null, assets[2]])
    })

    test('an expiration exactly equal to the tick timestamp is still active', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [BigInt(TICK), BigInt(TICK - 1), DISTANT_FUTURE])
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual([assets[0], null, assets[2]])
    })

    test('the local clock is never read: two calls around a boundary agree', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [BigInt(TICK - 1), BigInt(TICK + 1), DISTANT_FUTURE])
        const clock = jest.spyOn(Date, 'now')
        let first
        let second
        try {
            clock.mockReturnValue(0)
            first = manager.getAssets(CONTRACT_ID, TICK)
            clock.mockReturnValue(TICK + 10 * 60 * 1000)
            second = manager.getAssets(CONTRACT_ID, TICK)
        } finally {
            clock.mockRestore()
        }
        expect(first).toEqual([null, assets[1], assets[2]])
        expect(second).toEqual(first)
    })

    test('a missing timestamp is a programming error, not a silent local-clock read', () => {
        const manager = makeManager(assets)
        expect(() => manager.getAssets(CONTRACT_ID)).toThrow('Timestamp is required')
    })

    test('a fractional, infinite or non-numeric timestamp is rejected before it reaches BigInt', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [BigInt(TICK - 1), 0n, 0n])
        for (const timestamp of [TICK + 0.5, Infinity, NaN, String(TICK), BigInt(TICK)])
            expect(() => manager.getAssets(CONTRACT_ID, timestamp)).toThrow('Timestamp is required to evaluate asset expiration')
    })

    test('a shorter expiration array leaves the remaining assets active', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [BigInt(TICK - 1)])
        const result = manager.getAssets(CONTRACT_ID, TICK)
        expect(result[0]).toBe(null)
        expect(result[1]).toEqual(assets[1])
        expect(result[2]).toEqual(assets[2])
    })

    test('a longer expiration array never extends the asset list', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [DISTANT_FUTURE, DISTANT_FUTURE, DISTANT_FUTURE, BigInt(TICK - 1), BigInt(TICK - 1)])
        const result = manager.getAssets(CONTRACT_ID, TICK)
        expect(result).toHaveLength(3)
        expect(result).toEqual(assets)
    })

    test('a hole in the expiration array is unknown, so that asset is active', () => {
        const manager = makeManager(assets)
        const expiration = []
        expiration[1] = BigInt(TICK - 1)
        expiration[2] = 0n
        manager.setAssetExpiration(CONTRACT_ID, expiration)
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual([assets[0], null, null])
    })

    test('a non-array expiration is rejected and leaves every asset active', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, {0: 1n})
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual(assets)
    })

    test('an array-like expiration is rejected with a warning and never applied', () => {
        const logger = require('../../src/logger')
        logger.warn.mockClear()
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, {length: 1, 0: BigInt(TICK - 1)})
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual(assets)
        expect(logger.warn).toHaveBeenCalledWith({
            msg: 'Contract asset expiration is not an array; assets stay active',
            contract: CONTRACT_ID,
            expirationType: 'object'
        })
    })

    test('an empty expiration array leaves every asset active', () => {
        const manager = makeManager(assets)
        manager.setAssetExpiration(CONTRACT_ID, [])
        expect(manager.getAssets(CONTRACT_ID, TICK)).toEqual(assets)
    })
})
