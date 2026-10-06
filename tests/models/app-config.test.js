/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const AppConfig = require('../../src/models/app-config')

const secret = Keypair.random().secret()
const hash = 'a'.repeat(64)

/**
 * @param {object} [overrides] - fields merged over a minimal valid app config
 * @returns {AppConfig} parsed app config
 */
function appConfig(overrides = {}) {
    return new AppConfig({
        secret,
        dataSources: {pubnet: {type: 'db', name: 'pubnet', sorobanRpc: ['https://rpc.example.com'], providers: ['p']}},
        ...overrides
    })
}

describe('AppConfig.clusterConfigHash [NODE-F-01]', () => {
    test('is absent when the operator did not pin one, and the config stays valid', () => {
        const config = appConfig()
        expect(config.isValid).toBe(true)
        expect(config.clusterConfigHash).toBeUndefined()
    })

    test('accepts a 64 character hex hash and normalises its case', () => {
        const config = appConfig({clusterConfigHash: hash.toUpperCase()})
        expect(config.isValid).toBe(true)
        expect(config.clusterConfigHash).toBe(hash)
    })

    test('reports a malformed hash as an issue, which aborts boot', () => {
        const config = appConfig({clusterConfigHash: 'not-a-hash'})
        expect(config.isValid).toBe(false)
        expect(config.issuesString).toContain('clusterConfigHash')
    })

    test('round-trips through toPlainObject, so setTrace does not drop the anchor', () => {
        expect(appConfig({clusterConfigHash: hash}).toPlainObject().clusterConfigHash).toBe(hash)
    })
})

describe('AppConfig.orchestratorUrl', () => {
    test.each(['https://orchestrator.reflector.network', 'wss://orchestrator.example.com/ws'])('accepts %s', url => {
        const config = appConfig({orchestratorUrl: url})
        expect(config.isValid).toBe(true)
        expect(config.orchestratorUrl).toBe(url)
    })

    test.each([
        'http://localhost:12274',
        'ws://localhost:12274/ws',
        'http://127.0.0.1:12274',
        'http://[::1]:12274',
        'http://37.27.4.105:12274',
        'ws://orchestrator.example.com'
    ])('accepts %s: plain http and ws on any host', url => {
        const config = appConfig({orchestratorUrl: url})
        expect(config.isValid).toBe(true)
        expect(config.orchestratorUrl).toBe(url)
    })

    test('plain http or ws to another host is accepted with a warning: the cluster secret travels unencrypted', () => {
        const logger = require('../../src/logger')
        logger.warn.mockClear()

        appConfig({orchestratorUrl: 'http://37.27.4.105:12274'})

        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(logger.warn.mock.calls[0])).toContain('unencrypted')
    })

    test.each(['https://orchestrator.example.com', 'http://localhost:12274', 'ws://127.1.2.3:12274'])('%s logs no warning', url => {
        const logger = require('../../src/logger')
        logger.warn.mockClear()

        appConfig({orchestratorUrl: url})

        expect(logger.warn).not.toHaveBeenCalled()
    })

    test.each([
        'ftp://localhost',
        'ftp://orchestrator.example.com',
        'orchestrator.example.com'
    ])('refuses %s, which stops the boot', url => {
        const config = appConfig({orchestratorUrl: url})
        expect(config.isValid).toBe(false)
        expect(config.issuesString).toContain('orchestratorUrl')
    })

    test('an absent url stays absent, so the websocket server applies its https default', () => {
        const config = appConfig()
        expect(config.isValid).toBe(true)
        expect(config.orchestratorUrl).toBeUndefined()
    })
})

describe('AppConfig without dbSyncDelay', () => {
    const logger = require('../../src/logger')

    beforeEach(() => logger.warn.mockClear())

    test('the sync delays are not part of the node config', () => {
        const config = appConfig()
        expect(config.dbSyncDelay).toBeUndefined()
        expect(config.toPlainObject()).not.toHaveProperty('dbSyncDelay')
        expect(logger.warn).not.toHaveBeenCalled()
    })

    test('an old config that still sets dbSyncDelay boots, ignores it and says so once', () => {
        const config = appConfig({dbSyncDelay: 30})
        expect(config.isValid).toBe(true)
        expect(config.dbSyncDelay).toBeUndefined()
        expect(config.toPlainObject()).not.toHaveProperty('dbSyncDelay')
        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(logger.warn.mock.calls[0])).toContain('dbSyncDelay is no longer read')
    })
})
