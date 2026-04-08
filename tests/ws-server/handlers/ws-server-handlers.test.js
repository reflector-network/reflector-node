/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')
const {ContractTypes} = require('@reflector/reflector-shared')
const ChannelTypes = require('../../../src/ws-server/channels/channel-types')
const MessageTypes = require('../../../src/ws-server/handlers/message-types')

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
        const authPayload = 'payload-to-sign'
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
        const signature = keypair.sign(Buffer.from(channel.authPayload)).toString('hex')
        handler.handle(channel, {data: {signature}})

        expect(channel.validated).toHaveBeenCalled()
        expect(channel.close).not.toHaveBeenCalled()
    })

    test('invalid signature closes channel and does not validate', () => {
        handler.handle(channel, {data: {signature: '00'}})

        expect(channel.close).toHaveBeenCalledWith(1008, 'Invalid signature', true)
        expect(channel.validated).not.toHaveBeenCalled()
    })
})

describe('ConfigHandler', () => {
    const moduleDir = path.resolve(__dirname, '../../../src')
    let settingsManager
    let ConfigHandler

    const loadHandler = () => {
        jest.resetModules()
        settingsManager = {
            appConfig: {publicKey: 'NODE_PUBKEY'},
            setConfig: jest.fn(),
            setPendingConfig: jest.fn(),
            clearPendingConfig: jest.fn()
        }

        const mockContainer = {settingsManager}
        const mockNonceManager = {
            getNonce: jest.fn().mockReturnValue(0),
            setNonce: jest.fn(),
            nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig'}
        }

        class MockConfigEnvelope {
            constructor(data) {
                this.config = data.config
                this.signatures = data.signatures || []
            }
        }

        jest.doMock(path.join(moduleDir, 'domain', 'container.js'), () => mockContainer)
        jest.doMock(path.join(moduleDir, 'ws-server', 'nonce-manager.js'), () => mockNonceManager)
        jest.doMock('@reflector/reflector-shared', () => ({ConfigEnvelope: MockConfigEnvelope}))
        jest.doMock('@stellar/stellar-sdk', () => ({
            Keypair: {
                fromPublicKey: () => ({verify: () => true})
            }
        }))

        ConfigHandler = require('../../../src/ws-server/handlers/config-handler')
        return new ConfigHandler()
    }

    test('allows orchestrator channel with anonymous access', () => {
        const handler = loadHandler()
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(handler.allowAnonymous).toBe(true)
    })

    test('throws when data is missing', async () => {
        const handler = loadHandler()

        await expect(handler.handle({}, {})).rejects.toThrow('Data is required')
    })

    test('does not set config when currentConfig is invalid', async () => {
        const handler = loadHandler()
        const invalidConfig = {config: {isValid: false, issuesString: 'invalid'}, signatures: []}

        await handler.handle({}, {data: {currentConfig: invalidConfig}})

        expect(settingsManager.setConfig).not.toHaveBeenCalled()
        expect(settingsManager.clearPendingConfig).toHaveBeenCalled()
    })

    test('applies current config and clears pending config when pending config is absent', async () => {
        const handler = loadHandler()
        const currentConfig = {
            config: {isValid: true, getSignaturePayloadHash: () => 'dead'},
            signatures: [{nonce: 1, pubkey: 'NODE_PUBKEY', signature: 'dead'}]
        }

        await handler.handle({}, {data: {currentConfig}})

        expect(settingsManager.setConfig).toHaveBeenCalledWith(currentConfig.config, 1)
        expect(settingsManager.clearPendingConfig).toHaveBeenCalled()
    })

    test('applies pending config when it is verified', async () => {
        const handler = loadHandler()
        const currentConfig = {
            config: {isValid: true, getSignaturePayloadHash: () => 'dead'},
            signatures: [{nonce: 1, pubkey: 'NODE_PUBKEY', signature: 'dead'}]
        }
        const pendingConfig = {
            config: {isValid: true, getSignaturePayloadHash: () => 'dead'},
            signatures: [{nonce: 2, pubkey: 'NODE_PUBKEY', signature: 'dead'}]
        }

        await handler.handle({}, {data: {currentConfig, pendingConfig}})

        expect(settingsManager.setConfig).toHaveBeenCalledWith(currentConfig.config, 1)
        expect(settingsManager.setPendingConfig).toHaveBeenCalled()
        expect(settingsManager.clearPendingConfig).not.toHaveBeenCalled()
    })
})

describe('SignaturesHandler', () => {
    const moduleDir = path.resolve(__dirname, '../../../src')
    let SignaturesHandler
    let runnerManager
    let starSdkMock

    beforeEach(() => {
        jest.resetModules()
        const decoratedSignature = {signature: jest.fn(() => Buffer.from('signature'))}
        starSdkMock = {
            xdr: {
                DecoratedSignature: {
                    fromXDR: jest.fn(() => decoratedSignature)
                }
            },
            Keypair: {
                fromPublicKey: jest.fn(() => ({verify: jest.fn(() => true)}))
            }
        }

        const updatesRunner = {addSignature: jest.fn()}
        runnerManager = {
            updatesRunner,
            get: jest.fn(() => updatesRunner)
        }

        jest.doMock('@stellar/stellar-sdk', () => starSdkMock)
        jest.doMock(path.join(moduleDir, 'domain', 'runners', 'runner-manager.js'), () => runnerManager)
        SignaturesHandler = require('../../../src/ws-server/handlers/signatures-handler')
    })

    test('allows outgoing and incoming channels without anonymous access', () => {
        const handler = new SignaturesHandler()
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.OUTGOING, ChannelTypes.INCOMING])
        expect(handler.allowAnonymous).toBe(false)
    })

    test('ignores invalid message payload', async () => {
        const handler = new SignaturesHandler()
        await handler.handle({pubkey: 'pubkey'}, {data: {}})
        expect(runnerManager.get).not.toHaveBeenCalled()
        expect(runnerManager.updatesRunner.addSignature).not.toHaveBeenCalled()
    })

    test('adds signature to updates runner when hash and signature are valid', async () => {
        const handler = new SignaturesHandler()
        const message = {data: {signature: 'deadbeef', hash: 'abcdef', contractId: undefined}}

        await handler.handle({pubkey: 'public-key'}, message)

        expect(runnerManager.get).not.toHaveBeenCalled()
        expect(runnerManager.updatesRunner.addSignature).toHaveBeenCalled()
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

describe('LogsRequestHandler and LogFileRequestHandler', () => {
    let logsDir
    let tmpDir
    let container

    beforeEach(() => {
        jest.resetModules()
        const paths = createTempHome()
        tmpDir = paths.tmpDir
        logsDir = paths.logsDir
        container = require('../../../src/domain/container')
        container.homeDir = tmpDir
        container.settingsManager = {appConfig: {trace: true}}
    })

    afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, {recursive: true, force: true})
        }
    })

    test('allows orchestrator channel with anonymous access', () => {
        const LogsRequestHandler = require('../../../src/ws-server/handlers/logs-request-handler')
        const LogFileRequestHandler = require('../../../src/ws-server/handlers/log-file-request-handler')
        const logsHandler = new LogsRequestHandler()
        const logFileHandler = new LogFileRequestHandler()
        expect(logsHandler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(logsHandler.allowAnonymous).toBe(true)
        expect(logFileHandler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(logFileHandler.allowAnonymous).toBe(true)
    })

    test('returns available log file names and trace flag', () => {
        fs.writeFileSync(path.join(logsDir, 'app.log'), 'log content')
        fs.writeFileSync(path.join(logsDir, 'rotate.txt'), 'rotation')

        const LogsRequestHandler = require('../../../src/ws-server/handlers/logs-request-handler')
        const handler = new LogsRequestHandler()
        const result = handler.handle()

        expect(result).toEqual({logFiles: ['app.log'], isTraceEnabled: true})
    })

    test('returns file contents for log file request', () => {
        fs.writeFileSync(path.join(logsDir, 'app.log'), 'line 1\nline 2\n')
        const LogFileRequestHandler = require('../../../src/ws-server/handlers/log-file-request-handler')
        const handler = new LogFileRequestHandler()
        expect(handler.handle({}, {data: {logFileName: 'app.log'}})).toEqual({logFile: 'line 1\nline 2'})
    })
})

describe('SetTraceHandler', () => {
    let handler
    let container

    beforeEach(() => {
        jest.resetModules()
        const SetTraceHandler = require('../../../src/ws-server/handlers/set-trace-handler')
        handler = new SetTraceHandler()
        container = require('../../../src/domain/container')
        container.settingsManager = {setTrace: jest.fn()}
    })

    test('allows orchestrator channel with anonymous access', () => {
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(handler.allowAnonymous).toBe(true)
    })

    test('delegates trace enable/disable to settings manager', () => {
        handler.handle({}, {data: {isTraceEnabled: true}})
        expect(container.settingsManager.setTrace).toHaveBeenCalledWith(true)
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

    test('forwards SUBSCRIPTIONS sync data to subscriptions manager', () => {
        const handler = new SyncHandler()
        const syncData = {type: ContractTypes.SUBSCRIPTIONS, contractId: 'id', value: 123}
        handler.handle({}, {data: syncData})

        expect(getManager).toHaveBeenCalledWith('id')
        expect(mockManager.trySetRawSyncData).toHaveBeenCalledWith(syncData)
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
