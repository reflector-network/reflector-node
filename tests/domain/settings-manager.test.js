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
const dataSourcesManager = require('../../src/domain/data-sources-manager')

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

const CHALLENGE = 'b8b4a2f0c1d24e7f9a3b5c6d7e8f9012'

/**
 * @returns {SettingsManager} a manager with a signing key, ready for setGateways
 */
function makeGatewayManager() {
    const manager = new SettingsManager()
    manager.appConfig = {
        publicKey: 'GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX',
        keypair: {sign: () => Buffer.alloc(64, 3)}
    }
    return manager
}

describe('SettingsManager.setGateways', () => {
    beforeEach(() => {
        dataSourcesManager.setGateways.mockClear()
    })

    test('gateways is always an object, and no gateways configured is null, not an empty array', () => {
        const manager = makeGatewayManager()
        manager.setGateways({challenge: CHALLENGE}, false)
        expect(manager.gateways).toEqual({
            urls: null,
            configuredUrls: [],
            challenge: CHALLENGE,
            gatewayValidationKey: Buffer.alloc(64, 3).toString('base64')
        })
    })

    test('an explicitly empty list is also "no gateways configured"', () => {
        const manager = makeGatewayManager()
        manager.setGateways({urls: [], challenge: CHALLENGE}, false)
        expect(manager.gateways.urls).toBe(null)
        expect(manager.gateways.configuredUrls).toEqual([])
    })

    test('a valid https gateway is kept and normalised', () => {
        const manager = makeGatewayManager()
        manager.setGateways({urls: ['https://gateway.example.com/'], challenge: CHALLENGE}, false)
        expect(manager.gateways.urls).toEqual(['https://gateway.example.com'])
        expect(manager.gateways.configuredUrls).toEqual(['https://gateway.example.com/'])
    })

    test('invalid urls are dropped and the valid ones survive', () => {
        const manager = makeGatewayManager()
        manager.setGateways({
            urls: [
                'ftp://gateway.example.com',
                'https://user:pass@gateway.example.com',
                'https://10.0.0.5',
                'https://[::1]',
                'not-a-url',
                'https://good.example.com'
            ],
            challenge: CHALLENGE
        }, false)
        expect(manager.gateways.urls).toEqual(['https://good.example.com'])
    })

    test('configured but none usable is an empty array, which means "fail closed", not "go direct"', () => {
        const logger = require('../../src/logger')
        logger.error.mockClear()
        const manager = makeGatewayManager()
        manager.setGateways({urls: ['ftp://gateway.example.com', 'https://10.0.0.5'], challenge: CHALLENGE}, false)
        expect(manager.gateways.urls).toEqual([])
        expect(manager.gateways.configuredUrls).toEqual(['ftp://gateway.example.com', 'https://10.0.0.5'])
        expect(logger.error).toHaveBeenCalledTimes(1)
        expect(logger.error.mock.calls[0][0].msg).toBe('Every configured gateway url was rejected; webhook notifications will not be sent rather than go direct')
    })

    test('the configured list is what is reported and persisted, not the validated subset', () => {
        const manager = makeGatewayManager()
        manager.setGateways({urls: ['ftp://gateway.example.com', 'https://good.example.com'], challenge: CHALLENGE}, false)
        expect(manager.gateways.configuredUrls).toEqual(['ftp://gateway.example.com', 'https://good.example.com'])
        expect(manager.gateways.urls).toEqual(['https://good.example.com'])
    })

    test('the data source manager always receives the resulting object', () => {
        const manager = makeGatewayManager()
        manager.setGateways({urls: ['https://good.example.com'], challenge: CHALLENGE}, false)
        expect(dataSourcesManager.setGateways).toHaveBeenCalledTimes(1)
        expect(dataSourcesManager.setGateways).toHaveBeenCalledWith(manager.gateways)
    })

    test('a missing challenge is rejected instead of hashing the string "undefined"', () => {
        const manager = makeGatewayManager()
        expect(() => manager.setGateways({urls: []}, false)).toThrow('challenge')
        expect(manager.gateways).toBe(undefined)
        expect(dataSourcesManager.setGateways).not.toHaveBeenCalled()
    })

    test('a non-array urls value is rejected', () => {
        const manager = makeGatewayManager()
        expect(() => manager.setGateways({urls: 'https://good.example.com', challenge: CHALLENGE}, false)).toThrow('array')
    })

    test('too many gateways are rejected', () => {
        const manager = makeGatewayManager()
        const urls = Array(11).fill(0).map((_, i) => `https://gw${i}.example.com`)
        expect(() => manager.setGateways({urls, challenge: CHALLENGE}, false)).toThrow('Too many gateway urls')
    })

    test('ten gateways are accepted', () => {
        const manager = makeGatewayManager()
        const urls = Array(10).fill(0).map((_, i) => `https://gw${i}.example.com`)
        manager.setGateways({urls, challenge: CHALLENGE}, false)
        expect(manager.gateways.urls).toEqual(urls)
    })
})

describe('SettingsManager.setGateways, edge cases', () => {
    const fs = require('fs')
    const logger = require('../../src/logger')

    beforeEach(() => {
        dataSourcesManager.setGateways.mockClear()
        logger.info.mockClear()
    })

    test('an http gateway, as the dashboard builds it, is routable', () => {
        const manager = makeGatewayManager()
        manager.setGateways({urls: ['http://203.0.114.7:8080'], challenge: CHALLENGE}, false)
        expect(manager.gateways.urls).toEqual(['http://203.0.114.7:8080'])
    })

    test('a challenge that is not a string is rejected, not hashed', () => {
        const manager = makeGatewayManager()
        for (const challenge of [5, {}, ['c'], true])
            expect(() => manager.setGateways({urls: ['https://good.example.com'], challenge}, false)).toThrow('Gateway challenge is required')
        expect(manager.gateways).toBe(undefined)
        expect(dataSourcesManager.setGateways).not.toHaveBeenCalled()
    })

    test('a list that cannot be persisted is not applied either', () => {
        const manager = makeGatewayManager()
        manager.setGateways({urls: [], challenge: CHALLENGE}, false)
        dataSourcesManager.setGateways.mockClear()
        const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
            throw new Error('ENOSPC: no space left on device')
        })
        try {
            expect(() => manager.setGateways({urls: ['https://good.example.com'], challenge: CHALLENGE})).toThrow('ENOSPC')
        } finally {
            write.mockRestore()
        }
        expect(manager.gateways.urls).toBe(null)
        expect(dataSourcesManager.setGateways).not.toHaveBeenCalled()
    })

    test('debug mode logs a fingerprint of the validation key, never the key', () => {
        const manager = makeGatewayManager()
        const previous = process.env.DEBUG
        process.env.DEBUG = 'true'
        try {
            manager.setGateways({urls: ['https://good.example.com'], challenge: CHALLENGE}, false)
        } finally {
            if (previous === undefined)
                delete process.env.DEBUG
            else
                process.env.DEBUG = previous
        }
        const key = manager.gateways.gatewayValidationKey
        const fingerprint = require('crypto').createHash('sha256').update(key).digest('hex').slice(0, 8)
        expect(logger.info).toHaveBeenCalledWith({msg: 'Gateway validation key applied', fingerprint})
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain(key)
    })
})

describe('SettingsManager.statistics reports unusable gateways', () => {
    /**
     * @param {string[]|null} urls - routing set
     * @returns {object} statistics of a manager in that gateway state
     */
    function statisticsWith(urls) {
        const manager = makeGatewayManager()
        manager.appConfig.trace = false
        manager.gateways = {urls, configuredUrls: urls || [], challenge: CHALLENGE}
        return manager.statistics
    }

    test('gateways configured but none usable are a connection issue', () => {
        expect(statisticsWith([]).connectionIssues).toEqual([
            'Gateways are configured but none is usable: webhooks are not sent and exchanges prices are not fetched until the gateway list is fixed'
        ])
    })

    test('no gateways and usable gateways report nothing', () => {
        expect(statisticsWith(null).connectionIssues).toEqual([])
        expect(statisticsWith(['https://gw.example.com']).connectionIssues).toEqual([])
    })

    test('a manager that has not applied gateways yet reports nothing about them', () => {
        const manager = makeGatewayManager()
        manager.appConfig.trace = false
        expect(manager.statistics.connectionIssues).toEqual([])
    })

    //the growth needs the condition that produced it: the data source manager holds a registration issue (its issues
    //getter then returns its internal array) and the config names a data source the node lacks
    test('reading the statistics twice leaves the data source manager issues as they were', () => {
        const {ContractTypes} = require('@reflector/reflector-shared')
        const registrationIssue = 'Data source exchanges failed to register'
        dataSourcesManager.issues = [registrationIssue]
        dataSourcesManager.has.mockImplementation(name => name !== 'missing')
        try {
            const manager = makeGatewayManager()
            manager.appConfig.trace = false
            manager.config = {
                isValid: true,
                network: 'testnet',
                contracts: new Map([[CONTRACT_ID, {type: ContractTypes.ORACLE, dataSource: 'missing'}]]),
                getHash: () => 'config-hash'
            }

            const first = manager.statistics.connectionIssues
            const second = manager.statistics.connectionIssues

            expect(first).toEqual([registrationIssue, 'Connection data for data source missing not found'])
            expect(second).toEqual(first)
            expect(dataSourcesManager.issues).toEqual([registrationIssue])
        } finally {
            dataSourcesManager.issues = []
            dataSourcesManager.has.mockImplementation(() => true)
        }
    })
})
