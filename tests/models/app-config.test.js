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
        'http://192.168.0.21:12274',
        'ws://orchestrator.example.com',
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
