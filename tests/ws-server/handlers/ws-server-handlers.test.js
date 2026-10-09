/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')
const {ContractTypes} = require('@reflector/reflector-shared')
const ChannelTypes = require('../../../src/ws-server/channels/channel-types')
const MessageTypes = require('../../../src/ws-server/handlers/message-types')
const constants = require('../../../src/ws-server/contstants')

const createTempHome = () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-handlers-test-'))
    const logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, {recursive: true})
    return {tmpDir, logsDir}
}

describe('HandshakeRequestHandler', () => {
    let handler
    let container

    beforeEach(() => {
        jest.resetModules()
        container = require('../../../src/domain/container')
        const HandshakeRequestHandler = require('../../../src/ws-server/handlers/handshake-request-handler')
        handler = new HandshakeRequestHandler()
        container.settingsManager = {appConfig: {keypair: Keypair.random()}}
    })

    test('allows all channel types and anonymous access', () => {
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.OUTGOING, ChannelTypes.INCOMING, ChannelTypes.ORCHESTRATOR])
        expect(handler.allowAnonymous).toBe(true)
    })

    test('returns handshake response with signature', () => {
        const authPayload = constants.payloadPrefix + 'payload-to-sign'
        const result = handler.handle({}, {data: {payload: authPayload}})

        expect(result).toBeDefined()
        expect(result.type).toBe(MessageTypes.HANDSHAKE_RESPONSE)
        expect(result.data.signature).toMatch(/[0-9a-f]+/)
    })

    test('throws when payload is missing', () => {
        expect(() => handler.handle({}, {data: {}})).toThrow('Payload is required')
    })
})

describe('HandshakeResponseHandler', () => {
    let handler
    let channel
    let keypair

    beforeEach(() => {
        jest.resetModules()
        const HandshakeResponseHandler = require('../../../src/ws-server/handlers/handshake-response-handler')
        handler = new HandshakeResponseHandler()
        keypair = Keypair.random()
        channel = {
            pubkey: keypair.publicKey(),
            authPayload: 'payload-to-auth',
            close: jest.fn(),
            validated: jest.fn()
        }
    })

    test('allows outgoing and incoming channels with anonymous access', () => {
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.OUTGOING, ChannelTypes.INCOMING])
        expect(handler.allowAnonymous).toBe(true)
    })

    test('valid signature calls validated', () => {
        const signature = Buffer.from(keypair.sign(Buffer.from(channel.authPayload))).toString('hex')
        handler.handle(channel, {data: {signature}})

        expect(channel.validated).toHaveBeenCalled()
        expect(channel.close).not.toHaveBeenCalled()
    })

    test('invalid signature closes channel, does not validate and throws', () => {
        expect(() => handler.handle(channel, {data: {signature: '00'}})).toThrow('Invalid signature')

        expect(channel.close).toHaveBeenCalledWith(1008, 'Invalid signature', true)
        expect(channel.validated).not.toHaveBeenCalled()
    })

    test('signature over a different payload is rejected', () => {
        const signature = Buffer.from(keypair.sign(Buffer.from('some-other-payload'))).toString('hex')
        expect(() => handler.handle(channel, {data: {signature}})).toThrow('Invalid signature')
        expect(channel.validated).not.toHaveBeenCalled()
    })

    test('missing data closes channel and throws', () => {
        expect(() => handler.handle(channel, {})).toThrow('Signature is required')

        expect(channel.close).toHaveBeenCalledWith(1008, 'Invalid signature', true)
        expect(channel.validated).not.toHaveBeenCalled()
    })
})

describe('StateHandler', () => {
    const moduleDir = path.resolve(__dirname, '../../../src')
    let StateHandler
    let runnerManager
    let subscriptionsRunnerClass
    let container

    beforeEach(() => {
        jest.resetModules()
        container = require('../../../src/domain/container')
        runnerManager = {
            all: jest.fn()
        }

        subscriptionsRunnerClass = class SubscriptionsRunner {}
        jest.doMock(path.join(moduleDir, 'domain', 'runners', 'runner-manager.js'), () => runnerManager)
        jest.doMock(path.join(moduleDir, 'domain', 'runners', 'subscriptions-runner.js'), () => subscriptionsRunnerClass)

        StateHandler = require('../../../src/ws-server/handlers/state-handler')
    })

    test('allows only outgoing channel without anonymous access', () => {
        const handler = new StateHandler()
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.OUTGOING])
        expect(handler.allowAnonymous).toBe(false)
    })

    test('broadcasts signatures and sync data when state is READY', () => {
        const welcomeRunner = {broadcastSignatureTo: jest.fn()}
        const syncRunner = new subscriptionsRunnerClass()
        syncRunner.broadcastSignatureTo = jest.fn()
        syncRunner.broadcastSyncData = jest.fn()
        runnerManager.all.mockReturnValue([welcomeRunner, syncRunner])
        container.tradesManager = {sendTradesData: jest.fn()}

        const handler = new StateHandler()
        handler.handle({pubkey: 'pubkey'}, {data: {state: require('../../../src/domain/nodes/node-states').READY}})

        expect(welcomeRunner.broadcastSignatureTo).toHaveBeenCalledWith('pubkey')
        expect(syncRunner.broadcastSignatureTo).toHaveBeenCalledWith('pubkey')
        expect(syncRunner.broadcastSyncData).toHaveBeenCalled()
        expect(container.tradesManager.sendTradesData).toHaveBeenCalledWith('pubkey')
    })

    test('throws when state is unsupported', () => {
        const handler = new StateHandler()
        expect(() => handler.handle({}, {data: {state: 999}})).toThrow('State 999 is not supported')
    })
})

describe('StatisticsRequestHandler', () => {
    const moduleDir = path.resolve(__dirname, '../../../src')
    let StatisticsRequestHandler
    let statisticsManager

    beforeEach(() => {
        jest.resetModules()
        statisticsManager = {getStatistics: jest.fn(() => ({nodes: 1}))}
        jest.doMock(path.join(moduleDir, 'domain', 'statistics-manager.js'), () => statisticsManager)
        StatisticsRequestHandler = require('../../../src/ws-server/handlers/statistics-request-handler')
    })

    test('allows orchestrator channel with anonymous access', () => {
        const handler = new StatisticsRequestHandler()
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(handler.allowAnonymous).toBe(true)
    })

    test('returns values from statistics manager', () => {
        const handler = new StatisticsRequestHandler()
        expect(handler.handle()).toEqual({nodes: 1})
        expect(statisticsManager.getStatistics).toHaveBeenCalled()
    })
})

describe('SyncHandler', () => {
    const moduleDir = path.resolve(__dirname, '../../../src')
    let SyncHandler
    let getManager
    let mockManager

    beforeEach(() => {
        jest.resetModules()
        mockManager = {trySetRawSyncData: jest.fn()}
        getManager = jest.fn(() => mockManager)
        jest.doMock(path.join(moduleDir, 'domain', 'subscriptions', 'subscriptions-data-manager.js'), () => ({getManager}))
        jest.doMock('@reflector/reflector-shared', () => ({ContractTypes}))
        SyncHandler = require('../../../src/ws-server/handlers/sync-handler')
    })

    test('allows outgoing and incoming channels without anonymous access', () => {
        const handler = new SyncHandler()
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.OUTGOING, ChannelTypes.INCOMING])
        expect(handler.allowAnonymous).toBe(false)
    })

    test('forwards SUBSCRIPTIONS sync data to subscriptions manager, charged to the peer that sent it', () => {
        const handler = new SyncHandler()
        const syncData = {type: ContractTypes.SUBSCRIPTIONS, contractId: 'id', value: 123}
        handler.handle({pubkey: 'peer'}, {data: syncData})

        expect(getManager).toHaveBeenCalledWith('id')
        //the pending sync-data quota is per sender, so a handler that dropped the key would pool every peer into one
        expect(mockManager.trySetRawSyncData).toHaveBeenCalledWith(syncData, 'peer')
    })

    test('returns without throwing when the frame carries no usable data', () => {
        const handler = new SyncHandler()
        for (const data of [undefined, null, 'nope', 42, []])
            expect(() => handler.handle({}, {data})).not.toThrow()
        expect(getManager).not.toHaveBeenCalled()
    })

    test('ignores sync data for a contract this node does not run', () => {
        getManager.mockReturnValue(undefined)
        const handler = new SyncHandler()

        expect(() => handler.handle({pubkey: 'peer'}, {data: {type: ContractTypes.SUBSCRIPTIONS, contractId: 'unknown'}})).not.toThrow()
        expect(mockManager.trySetRawSyncData).not.toHaveBeenCalled()
    })
})

describe('GatewaysGetHandler and GatewaysPostHandler', () => {
    const moduleDir = path.resolve(__dirname, '../../../src')
    let GatewaysGetHandler
    let GatewaysPostHandler
    let settingsManager
    let nonceManager
    let sharedMock

    beforeEach(() => {
        jest.resetModules()
        settingsManager = {
            appConfig: {publicKey: 'NODE_PUBLIC_KEY'},
            gateways: {urls: ['https://example.com'], challenge: 'challenge'},
            setGateways: jest.fn()
        }

        nonceManager = {
            getNonce: jest.fn().mockReturnValue(0),
            setNonce: jest.fn(),
            nonceTypes: {GATEWAYS: 'gateways'}
        }

        sharedMock = {
            getDataHash: jest.fn((data) => `hash-${data}`),
            verifySignature: jest.fn(() => true)
        }

        jest.doMock(path.join(moduleDir, 'domain', 'container.js'), () => ({settingsManager}))
        jest.doMock(path.join(moduleDir, 'ws-server', 'nonce-manager.js'), () => nonceManager)
        jest.doMock('@reflector/reflector-shared', () => sharedMock)

        const handlers = require('../../../src/ws-server/handlers/gateways-handler')
        GatewaysGetHandler = handlers.GatewaysGetHandler
        GatewaysPostHandler = handlers.GatewaysPostHandler
    })

    test('allows orchestrator channel with anonymous access', () => {
        const getHandler = new GatewaysGetHandler()
        const postHandler = new GatewaysPostHandler()
        expect(getHandler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(getHandler.allowAnonymous).toBe(true)
        expect(postHandler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(postHandler.allowAnonymous).toBe(true)
    })

    test('returns gateway metadata when the request is valid', () => {
        const handler = new GatewaysGetHandler()
        const payload = 'https://gateway.example.com?nonce=1'
        const result = handler.handle({}, {
            data: {
                signature: 'signature',
                data: {payload}
            }
        })

        expect(result).toEqual({urls: ['https://example.com'], challenge: 'challenge'})
        expect(sharedMock.verifySignature).toHaveBeenCalled()
        expect(nonceManager.setNonce).toHaveBeenCalledWith('gateways', 1)
    })

    test('reports the configured list, never the routing subset that passed validation', () => {
        settingsManager.gateways = {urls: [], configuredUrls: ['ftp://plain.example.com'], challenge: 'challenge', gatewayValidationKey: 'k'}
        const handler = new GatewaysGetHandler()
        const result = handler.handle({}, {
            data: {
                signature: 'signature',
                data: {payload: 'https://gateway.example.com?nonce=1'}
            }
        })

        expect(result).toEqual({urls: ['ftp://plain.example.com'], challenge: 'challenge', unusable: true})
    })

    test('accepts valid gateway post and applies new gateway values', () => {
        const handler = new GatewaysPostHandler()
        const payload = {nonce: 1, urls: ['https://new.example.com'], challenge: 'new-challenge'}

        handler.handle({}, {data: {signature: 'signature', data: payload}})

        expect(settingsManager.setGateways).toHaveBeenCalledWith({urls: payload.urls, challenge: payload.challenge})
        expect(nonceManager.setNonce).toHaveBeenCalledWith('gateways', 1)
    })
})

describe('PriceSyncHandler', () => {
    let handler
    let container

    beforeEach(() => {
        jest.resetModules()
        const PriceSyncHandler = require('../../../src/ws-server/handlers/price-sync-handler')
        handler = new PriceSyncHandler()
        container = require('../../../src/domain/container')
        container.tradesManager = {addSyncData: jest.fn()}
    })

    test('allows only incoming channel without anonymous access', () => {
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.INCOMING])
        expect(handler.allowAnonymous).toBe(false)
    })

    test('delegates price sync data to trades manager', () => {
        const syncData = {price: 123}
        handler.handle({pubkey: 'pubkey'}, {data: syncData})

        expect(container.tradesManager.addSyncData).toHaveBeenCalledWith('pubkey', syncData)
    })
})

describe('LogTokenHandler', () => {
    let tmpDir
    let container
    let handler

    beforeEach(() => {
        jest.resetModules()
        tmpDir = createTempHome().tmpDir
        container = require('../../../src/domain/container')
        container.homeDir = tmpDir
        const LogTokenHandler = require('../../../src/ws-server/handlers/log-token-handler')
        handler = new LogTokenHandler()
    })

    afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir))
            fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    test('allows orchestrator channel with anonymous access', () => {
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(handler.allowAnonymous).toBe(true)
    })

    test('writes the token to <home>/promtail/token', () => {
        const token = 'ab'.repeat(32)
        handler.handle({}, {data: {token}})
        const tokenPath = path.join(tmpDir, 'promtail', 'token')
        expect(fs.readFileSync(tokenPath, 'utf8')).toBe(token)
        expect(fs.existsSync(`${tokenPath}.tmp`)).toBe(false)
    })

    test('replaces an existing token', () => {
        handler.handle({}, {data: {token: 'ab'.repeat(32)}})
        handler.handle({}, {data: {token: 'cd'.repeat(32)}})
        expect(fs.readFileSync(path.join(tmpDir, 'promtail', 'token'), 'utf8')).toBe('cd'.repeat(32))
    })

    test('rejects a malformed token and writes nothing', () => {
        expect(() => handler.handle({}, {data: {token: 'not-a-token'}})).toThrow('Invalid log token')
        expect(() => handler.handle({}, {data: {}})).toThrow('Invalid log token')
        expect(fs.existsSync(path.join(tmpDir, 'promtail', 'token'))).toBe(false)
    })
})
