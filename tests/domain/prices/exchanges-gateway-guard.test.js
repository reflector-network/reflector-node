/*eslint-disable no-undef */
//a stand-in connector whose setGateway keeps any non-empty list as given and whose request path goes direct whenever
//the chosen gateway is falsy, so the node's own check is what keeps the [null] hand-off of "configured, none usable"
//from fetching. mockRoutes records the route each fetch would have taken.
const mockRoutes = []
jest.mock('@reflector/reflector-exchanges-connector', () => (
    class FakeExchangesConnector201 {
        static setGateway(gateways) {
            if (!gateways || (Array.isArray(gateways) && gateways.length === 0)) {
                FakeExchangesConnector201.gatewayUrls = null
                return
            }
            FakeExchangesConnector201.gatewayUrls = Array.isArray(gateways) ? gateways : [gateways]
        }

        //eslint-disable-next-line class-methods-use-this
        setGateway(gateways, validationKey) {
            FakeExchangesConnector201.setGateway(gateways, validationKey)
        }

        //eslint-disable-next-line class-methods-use-this
        getPriceData({count}) {
            const gatewayUrl = FakeExchangesConnector201.gatewayUrls ? FakeExchangesConnector201.gatewayUrls[0] : undefined
            mockRoutes.push(gatewayUrl ? gatewayUrl : 'direct') //`if (gatewayUrl)`, otherwise the plain url
            return Promise.resolve(Array.from({length: count}, () => [[{volume: 100n, quoteVolume: 200n, source: 'binance'}]]))
        }
    }
))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), setNodes: jest.fn(), sendTo: jest.fn(), getConnectedNodes: jest.fn(() => [])}))

const {Asset} = require('@reflector/reflector-shared')
const logger = require('../../../src/logger')
const container = require('../../../src/domain/container')
const SettingsManager = require('../../../src/domain/settings-manager')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')

stopTradesManagersAfterEach(TradesManager)

const SELF = 'GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX'
const noRouteMessage = 'Gateways are configured but none is usable; exchanges prices are not fetched rather than fetched directly'

/**
 * Installs a real settings manager whose gateway state comes from setGateways, so the hand-off to the connector is the
 * production one
 * @param {string[]} configuredUrls - gateway list as the operator configured it
 * @returns {SettingsManager}
 */
function installGateways(configuredUrls) {
    const manager = new SettingsManager()
    manager.appConfig = {publicKey: SELF, dbSyncDelay: 0, keypair: {sign: () => Buffer.alloc(64, 3)}}
    manager.config = {nodes: new Map([[SELF, {pubkey: SELF}]]), contracts: new Map()}
    manager.getPriceHeartbeat = () => 2 * 60 * 60 * 1000
    manager.getSimSource = () => undefined
    manager.setGateways({urls: configuredUrls, challenge: 'b8b4a2f0c1d24e7f9a3b5c6d7e8f9012'}, false)
    container.settingsManager = manager
    return manager
}

/**
 * @param {string} source - data source name
 * @returns {AssetsMap}
 */
function makeMap(source) {
    return new AssetsMap(source, new Asset(2, 'USD'), [new Asset(2, 'BTC')])
}

beforeEach(() => {
    mockRoutes.length = 0
    logger.warn.mockClear()
})

describe('exchanges fetch in each gateway state, against a connector that does not fail closed', () => {
    test('the stand-in really does go direct on [null], so the node guard is what keeps the address hidden', async () => {
        const manager = installGateways(['ftp://gw.example.com'])
        expect(manager.gateways.urls).toEqual([])
        const ExchangesConnector = require('@reflector/reflector-exchanges-connector')
        expect(ExchangesConnector.gatewayUrls).toEqual([null])
        await new ExchangesConnector().getPriceData({count: 1})
        expect(mockRoutes).toEqual(['direct'])
    })

    test('configured but none usable: the connector is never called and one warning names no url', async () => {
        installGateways(['ftp://gw.example.com/t0ken', 'https://user:pw@gw2.example.com'])
        const tradesManager = new TradesManager()

        await tradesManager.loadTradesDataForSource(makeMap('exchanges'))
        await tradesManager.loadTradesDataForSource(makeMap('exchanges'))

        expect(mockRoutes).toEqual([])
        //the second layer is still handed over: a connector that fails closed on [null] refuses on its own as well
        expect(require('@reflector/reflector-exchanges-connector').gatewayUrls).toEqual([null])
        const warnings = logger.warn.mock.calls.map(([entry]) => entry).filter(entry => entry.msg === noRouteMessage)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toEqual({msg: noRouteMessage, source: 'exchanges', timestamp: expect.any(Number)})
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('gw.example.com')
    })

    test('no gateways configured: the fetch goes direct, the only route there is', async () => {
        installGateways([])
        const tradesManager = new TradesManager()

        await tradesManager.loadTradesDataForSource(makeMap('exchanges'))

        expect(mockRoutes).toEqual(['direct'])
        expect(logger.warn.mock.calls.filter(([entry]) => entry.msg === noRouteMessage)).toHaveLength(0)
    })

    test('a usable gateway: the fetch goes through it', async () => {
        installGateways(['http://203.0.113.9:8080', 'http://gw.example.com:8080/'])
        const tradesManager = new TradesManager()

        await tradesManager.loadTradesDataForSource(makeMap('exchanges'))

        expect(mockRoutes).toEqual(['http://gw.example.com:8080'])
    })
})

describe('the guard covers the gateway-routed source only', () => {
    test('another source is still loaded in the unusable state: forex never uses gateways', async () => {
        installGateways(['ftp://gw.example.com'])
        const tradesManager = new TradesManager()

        //this suite registers no forex source, so reaching the lookup is what shows the guard let it through
        await expect(tradesManager.loadTradesDataForSource(makeMap('forex'))).rejects.toThrow('Data source forex not found')
        expect(logger.warn.mock.calls.filter(([entry]) => entry.msg === noRouteMessage)).toHaveLength(0)
    })
})
