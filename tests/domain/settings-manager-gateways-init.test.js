/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')

//gatewaysPath is fixed from container.homeDir when the settings manager is loaded, so the home is a fresh temporary
//directory; it is emptied file by file afterwards, never removed recursively
jest.mock('../../src/domain/container', () => ({
    homeDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reflector-gateways-init-')),
    settingsManager: null,
    tradesManager: {setNodes: jest.fn()}
}))
jest.mock('../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 0),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways'}
}))
jest.mock('../../src/domain/runners/runner-manager', () => ({setContracts: jest.fn(), start: jest.fn()}))
jest.mock('../../src/domain/nodes/nodes-manager', () => ({setNodes: jest.fn(), broadcast: jest.fn(), sendTo: jest.fn(), getConnectedNodes: jest.fn(() => [])}))
jest.mock('../../src/domain/statistics-manager', () => ({setContractIds: jest.fn(), setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../src/domain/data-sources-manager', () => ({setDataSources: jest.fn(), setGateways: jest.fn(), get: jest.fn()}))
jest.mock('../../src/utils/requests-helper', () => ({makeRequest: jest.fn(), loggableHost: jest.fn(() => 'host')}))
jest.mock('../../src/domain/subscriptions/subscriptions-data-manager', () => ({
    addManager: jest.fn(),
    getManager: jest.fn(),
    removeManager: jest.fn(),
    getAllSubscriptions: jest.fn(() => [])
}))

const logger = require('../../src/logger')
const container = require('../../src/domain/container')
const dataSourcesManager = require('../../src/domain/data-sources-manager')
const {makeRequest} = require('../../src/utils/requests-helper')
const SettingsManager = require('../../src/domain/settings-manager')
const SubscriptionsRunner = require('../../src/domain/runners/subscriptions-runner')
const {checkGateways} = require('../../src/utils/check-gateways')

const gatewaysPath = path.join(container.homeDir, 'gateways.json')
const appConfigPath = path.join(container.homeDir, 'app.config.json')
const CHALLENGE = 'b8b4a2f0c1d24e7f9a3b5c6d7e8f9012'
const unusableFileMessage = 'gateways.json cannot be used; webhook posts and gateway price fetches fail closed until it is repaired'
const rejectedMessage = 'Every configured gateway url was rejected; webhook notifications will not be sent rather than go direct'

beforeAll(() => {
    fs.writeFileSync(appConfigPath, JSON.stringify({
        secret: Keypair.random().secret(),
        dataSources: {exchanges: {type: 'api', name: 'exchanges', providers: ['binance']}}
    }))
})

afterAll(() => {
    for (const file of fs.readdirSync(container.homeDir))
        fs.unlinkSync(path.join(container.homeDir, file))
    fs.rmdirSync(container.homeDir)
})

beforeEach(() => {
    dataSourcesManager.setGateways.mockClear()
    logger.error.mockClear()
    makeRequest.mockClear()
})

/**
 * Routes one trigger through the real routing code on the given manager
 * @param {SettingsManager} manager - manager produced by init
 * @returns {Promise<SubscriptionsRunner>} the runner, with both post paths recorded
 */
async function routeOneTrigger(manager) {
    container.settingsManager = manager
    const runner = Object.create(SubscriptionsRunner.prototype)
    runner.contractId = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
    runner.__payloadMajorityData = {promise: Promise.resolve(true)}
    runner.__processSingleTriggerDataItem = () => ({urls: ['https://subscriber.example.com/hook'], data: {}})
    runner.__postNotificationsViaGateway = jest.fn()
    runner.__postNotifications = jest.fn()
    await runner.__processTriggerData([{}], ['e'], 'root', 1_700_000_000_000)
    return runner
}

describe('SettingsManager.init with a gateways.json it cannot use', () => {
    const unusable = [
        ['cannot be parsed', '{"urls": ["https://gw.example.com"], "challenge": '],
        ['has a hand-edited url missing its quotes', '{"urls": ["https://gw.example.com/t0ken", https://gw2.example.com/x], "challenge": "c"}'],
        ['has no challenge', JSON.stringify({urls: ['https://gw.example.com']}, null, 2)],
        ['has a challenge that is not a string', JSON.stringify({urls: ['https://gw.example.com'], challenge: 5}, null, 2)],
        ['lists only urls no node accepts', JSON.stringify({urls: ['ftp://gw.example.com', 'http://10.0.0.5:8080'], challenge: CHALLENGE}, null, 2)],
        ['is not a gateways object', 'null'],
        ['has a non-array urls value', JSON.stringify({urls: 'https://gw.example.com', challenge: CHALLENGE}, null, 2)],
        ['lists more than ten urls', JSON.stringify({urls: Array(11).fill(0).map((_, i) => `https://gw${i}.example.com`), challenge: CHALLENGE}, null, 2)]
    ]
    for (const [name, content] of unusable)
        test(`a file that ${name} fails closed, stays exactly as it was, and nothing is posted directly`, async () => {
            fs.writeFileSync(gatewaysPath, content)
            const manager = new SettingsManager()

            await manager.init()

            //configured but none usable - the data source manager receives [] and hands the exchanges connector [null]
            expect(manager.gateways.urls).toEqual([])
            expect(dataSourcesManager.setGateways).toHaveBeenCalledTimes(1)
            expect(dataSourcesManager.setGateways).toHaveBeenLastCalledWith(manager.gateways)
            //the operator's file is not rewritten as "no gateways configured"
            expect(fs.readFileSync(gatewaysPath, 'utf8')).toBe(content)
            //one error, naming the file: the placeholder state is never run through validation, which would add a second
            //error about an empty url the file does not contain. A list that parsed but whose every entry is refused
            //is state 3 through validation itself, and says so in its own single error
            expect(logger.error).toHaveBeenCalledTimes(1)
            expect(logger.error.mock.calls[0][0].msg).toBe(name === 'lists only urls no node accepts' ? rejectedMessage : unusableFileMessage)
            //a JSON.parse message quotes the text it failed on, which would put the gateway path token in the log
            expect(JSON.stringify(logger.error.mock.calls)).not.toContain('t0ken')

            const runner = await routeOneTrigger(manager)
            expect(runner.__postNotifications).not.toHaveBeenCalled()
            expect(runner.__postNotificationsViaGateway).not.toHaveBeenCalled()
            expect(makeRequest).not.toHaveBeenCalled()
        })

    test('a file that cannot be read at all fails closed the same way', async () => {
        fs.rmSync(gatewaysPath, {force: true})
        fs.mkdirSync(gatewaysPath) //reading a directory throws, as an unreadable file does
        try {
            const manager = new SettingsManager()

            await manager.init()

            expect(manager.gateways.urls).toEqual([])
            expect(manager.gateways.configuredUrls).toEqual([''])
            expect(fs.statSync(gatewaysPath).isDirectory()).toBe(true)
            expect(logger.error).toHaveBeenCalledTimes(1)
            expect(logger.error.mock.calls[0][0].msg).toBe('gateways.json cannot be used; webhook posts and gateway price fetches fail closed until it is repaired')
            const runner = await routeOneTrigger(manager)
            expect(runner.__postNotifications).not.toHaveBeenCalled()
            expect(runner.__postNotificationsViaGateway).not.toHaveBeenCalled()
        } finally {
            fs.rmdirSync(gatewaysPath)
        }
    })

    test('a missing file is first boot: no gateways configured, and the synthesised file is written', async () => {
        fs.rmSync(gatewaysPath, {force: true})
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.gateways.urls).toBe(null)
        expect(manager.gateways.configuredUrls).toEqual([])
        expect(manager.gateways.challenge).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        expect(JSON.parse(fs.readFileSync(gatewaysPath, 'utf8'))).toEqual({urls: [], challenge: manager.gateways.challenge})
        const runner = await routeOneTrigger(manager)
        expect(runner.__postNotifications).toHaveBeenCalledTimes(1)
        expect(runner.__postNotificationsViaGateway).not.toHaveBeenCalled()
    })

    test('a file setGateways accepts is applied as it stands and never rewritten', async () => {
        const content = JSON.stringify({urls: ['ftp://plain.example.com', 'https://gw.example.com/'], challenge: CHALLENGE})
        fs.writeFileSync(gatewaysPath, content)
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.gateways.urls).toEqual(['https://gw.example.com'])
        expect(manager.gateways.configuredUrls).toEqual(['ftp://plain.example.com', 'https://gw.example.com/'])
        expect(manager.gateways.challenge).toBe(CHALLENGE)
        expect(fs.readFileSync(gatewaysPath, 'utf8')).toBe(content)
        const runner = await routeOneTrigger(manager)
        expect(runner.__postNotificationsViaGateway).toHaveBeenCalledTimes(1)
        expect(runner.__postNotifications).not.toHaveBeenCalled()
    })

    //the release pre-flight (check-gateways.js) must judge a file as the node does; an editor on Windows may save it
    //with a UTF-8 byte-order mark, which the node's trim drops
    test('a file saved with a byte-order mark is applied, as the release pre-flight judges it', async () => {
        const content = JSON.stringify({urls: ['https://gw.example.com'], challenge: CHALLENGE})
        fs.writeFileSync(gatewaysPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]))
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.gateways.urls).toEqual(['https://gw.example.com'])
        expect(manager.gateways.challenge).toBe(CHALLENGE)
        expect(logger.error).not.toHaveBeenCalled()
        expect(checkGateways(fs.readFileSync(gatewaysPath, 'utf8'))).toEqual({state: 'usable', problems: []})
    })

    test('a saved list is the configured one, so a state-3 list reads back as state 3 on the next boot', async () => {
        const manager = new SettingsManager()
        await manager.init()
        manager.setGateways({urls: ['ftp://plain.example.com'], challenge: CHALLENGE})
        expect(manager.gateways.urls).toEqual([])
        expect(JSON.parse(fs.readFileSync(gatewaysPath, 'utf8'))).toEqual({urls: ['ftp://plain.example.com'], challenge: CHALLENGE})

        const rebooted = new SettingsManager()
        await rebooted.init()
        expect(rebooted.gateways.urls).toEqual([])
        expect(rebooted.gateways.configuredUrls).toEqual(['ftp://plain.example.com'])
    })
})

describe('SettingsManager.init with an empty gateway list', () => {
    const {Asset} = require('@reflector/reflector-shared')
    const AssetsMap = require('../../src/domain/prices/assets-map')
    const TradesManager = require('../../src/domain/prices/trades-manager')

    /**
     * Loads exchanges prices once through the real trades manager on the given manager
     * @param {SettingsManager} manager - manager produced by init
     * @returns {Promise<jest.Mock>} the connector's getPriceData
     */
    async function fetchExchangesPrices(manager) {
        const getPriceData = jest.fn(({count}) => Promise.resolve(Array.from({length: count}, () => [[{volume: 1n, quoteVolume: 2n, source: 'binance'}]])))
        dataSourcesManager.get.mockReturnValue({name: 'exchanges', instance: {getPriceData}})
        manager.config = {nodes: new Map([[manager.appConfig.publicKey, {}]]), contracts: new Map()}
        manager.getSimSource = () => undefined
        manager.getPriceHeartbeat = () => 2 * 60 * 60 * 1000
        container.settingsManager = manager
        const tradesManager = new TradesManager()
        try {
            await tradesManager.loadTradesDataForSource(new AssetsMap('exchanges', new Asset(2, 'USD'), [new Asset(2, 'BTC')]))
        } finally {
            tradesManager.stop()
        }
        return getPriceData
    }

    const unconfigured = [
        ['an empty list and no challenge', JSON.stringify({urls: []}, null, 2), null],
        ['no list and no challenge', '{}', null],
        ['a null list and a challenge that is not a string', JSON.stringify({urls: null, challenge: 5}), null],
        ['an empty list and a challenge', JSON.stringify({urls: [], challenge: CHALLENGE}), CHALLENGE]
    ]
    for (const [name, content, challenge] of unconfigured)
        test(`a file with ${name} is "no gateways configured": webhooks and exchanges prices go direct, the file is left alone`, async () => {
            fs.writeFileSync(gatewaysPath, content)
            const manager = new SettingsManager()

            await manager.init()

            expect(manager.gateways.urls).toBe(null)
            expect(manager.gateways.configuredUrls).toEqual([])
            if (challenge)
                expect(manager.gateways.challenge).toBe(challenge)
            else
                expect(manager.gateways.challenge).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
            expect(fs.readFileSync(gatewaysPath, 'utf8')).toBe(content)
            expect(logger.error).not.toHaveBeenCalled()

            const runner = await routeOneTrigger(manager)
            expect(runner.__postNotifications).toHaveBeenCalledTimes(1)
            expect(runner.__postNotificationsViaGateway).not.toHaveBeenCalled()
            expect(await fetchExchangesPrices(manager)).toHaveBeenCalledTimes(1)
        })

    test('what a first boot writes reads back on the next boot as "no gateways configured", unchanged', async () => {
        fs.rmSync(gatewaysPath, {force: true})
        const first = new SettingsManager()
        await first.init()
        const written = fs.readFileSync(gatewaysPath, 'utf8')

        const rebooted = new SettingsManager()
        await rebooted.init()

        expect(rebooted.gateways.urls).toBe(null)
        expect(rebooted.gateways.challenge).toBe(first.gateways.challenge)
        expect(fs.readFileSync(gatewaysPath, 'utf8')).toBe(written)
        expect(await fetchExchangesPrices(rebooted)).toHaveBeenCalledTimes(1)
    })

    test('configured but none usable: the exchanges connector is never called', async () => {
        fs.writeFileSync(gatewaysPath, JSON.stringify({urls: ['ftp://gw.example.com'], challenge: CHALLENGE}))
        const manager = new SettingsManager()
        await manager.init()

        expect(manager.gateways.urls).toEqual([])
        expect(await fetchExchangesPrices(manager)).not.toHaveBeenCalled()
    })
})
