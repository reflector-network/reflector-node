/*eslint-disable no-undef */
const {Asset} = require('@reflector/reflector-shared')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')

stopTradesManagersAfterEach(TradesManager)

function makeAssetsMap(source, baseCode, assetCodes) {
    return new AssetsMap(source, new Asset(2, baseCode), assetCodes.map(c => new Asset(2, c)))
}

function flushPromises() {
    return new Promise(resolve => jest.requireActual('timers').setImmediate(resolve))
}

/**
 * The container and the TradesManager class from the current module registry. The connector budget suite resets the
 * registry, and once it has run the top-level TradesManager import reads a different container from the one a test
 * requires and patches. A test that patches the container must build its manager from this pair. Such a manager is not
 * seen by stopTradesManagersAfterEach, so the test stops it itself
 * @returns {{container: object, CurrentTradesManager: Function}}
 */
function requireCurrentModules() {
    return {
        container: require('../../../src/domain/container'),
        CurrentTradesManager: require('../../../src/domain/prices/trades-manager')
    }
}

describe('__loadDataForAssetMap', () => {
    let manager
    let loadCalls
    let resolvers

    beforeEach(() => {
        jest.useFakeTimers()
        manager = new TradesManager()
        loadCalls = []
        resolvers = []
        //mock loadTradesDataForSource to track calls and control resolution
        manager.loadTradesDataForSource = jest.fn((assetsMap) => new Promise((resolve, reject) => {
            loadCalls.push({assetsMap, resolve, reject})
            resolvers.push({resolve, reject})
        }))
    })

    test('first call for a key starts a load', () => {
        const map = makeAssetsMap('exchanges', 'USD', ['BTC'])

        manager.__loadDataForAssetMap(map)

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(1)
        expect(manager.loadTradesDataForSource).toHaveBeenCalledWith(map)
    })

    test('second call for same key queues instead of starting a new load', () => {
        const map1 = makeAssetsMap('exchanges', 'USD', ['BTC'])
        const map2 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH'])

        manager.__loadDataForAssetMap(map1)
        manager.__loadDataForAssetMap(map2)

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(1)
    })

    test('queued map is loaded after current request resolves', async () => {
        const map1 = makeAssetsMap('exchanges', 'USD', ['BTC'])
        const map2 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH'])

        manager.__loadDataForAssetMap(map1)
        manager.__loadDataForAssetMap(map2)

        //resolve first load
        resolvers[0].resolve()
        await flushPromises()

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(2)
        expect(manager.loadTradesDataForSource).toHaveBeenLastCalledWith(map2)
    })

    test('only the latest queued map is kept (intermediate maps are dropped)', async () => {
        const map1 = makeAssetsMap('exchanges', 'USD', ['BTC'])
        const map2 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH'])
        const map3 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH', 'XRP'])

        manager.__loadDataForAssetMap(map1)
        manager.__loadDataForAssetMap(map2)
        manager.__loadDataForAssetMap(map3) //overwrites map2

        resolvers[0].resolve()
        await flushPromises()

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(2)
        expect(manager.loadTradesDataForSource).toHaveBeenLastCalledWith(map3)
    })

    test('pending request is cleaned up after resolve with no queued map', async () => {
        const map1 = makeAssetsMap('exchanges', 'USD', ['BTC'])

        manager.__loadDataForAssetMap(map1)
        resolvers[0].resolve()
        await flushPromises()

        //calling again should start a fresh load, not get stuck
        const map2 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH'])
        manager.__loadDataForAssetMap(map2)

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(2)
        expect(manager.loadTradesDataForSource).toHaveBeenLastCalledWith(map2)
    })

    test('pending request is cleaned up after rejection', async () => {
        const map1 = makeAssetsMap('exchanges', 'USD', ['BTC'])

        manager.__loadDataForAssetMap(map1)
        resolvers[0].reject(new Error('load failed'))
        await flushPromises()

        //should not be stuck - a new call should start a fresh load
        const map2 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH'])
        manager.__loadDataForAssetMap(map2)

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(2)
        expect(manager.loadTradesDataForSource).toHaveBeenLastCalledWith(map2)
    })

    test('queued map is loaded after rejection', async () => {
        const map1 = makeAssetsMap('exchanges', 'USD', ['BTC'])
        const map2 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH'])

        manager.__loadDataForAssetMap(map1)
        manager.__loadDataForAssetMap(map2)

        resolvers[0].reject(new Error('load failed'))
        await flushPromises()

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(2)
        expect(manager.loadTradesDataForSource).toHaveBeenLastCalledWith(map2)
    })

    test('different keys run in parallel', () => {
        const mapA = makeAssetsMap('exchanges', 'USD', ['BTC'])
        const mapB = makeAssetsMap('pubnet', 'USDC', ['XLM'])

        manager.__loadDataForAssetMap(mapA)
        manager.__loadDataForAssetMap(mapB)

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(2)
    })

    test('chained queued loads work across multiple cycles', async () => {
        const map1 = makeAssetsMap('exchanges', 'USD', ['BTC'])
        const map2 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH'])

        manager.__loadDataForAssetMap(map1)
        manager.__loadDataForAssetMap(map2)

        //resolve first -> triggers map2 load
        resolvers[0].resolve()
        await flushPromises()
        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(2)

        //queue map3 while map2 is loading
        const map3 = makeAssetsMap('exchanges', 'USD', ['BTC', 'ETH', 'XRP'])
        manager.__loadDataForAssetMap(map3)

        //resolve map2 -> triggers map3 load
        resolvers[1].resolve()
        await flushPromises()

        expect(manager.loadTradesDataForSource).toHaveBeenCalledTimes(3)
        expect(manager.loadTradesDataForSource).toHaveBeenLastCalledWith(map3)
    })
})

describe('loadTradesData', () => {
    test('evaluates asset expiry at the tick timestamp it was given', () => {
        const {container, CurrentTradesManager} = requireCurrentModules()
        const {Asset, ContractTypes} = require('@reflector/reflector-shared')
        const original = container.settingsManager
        const getAssets = jest.fn(() => [new Asset(2, 'BTC')])
        container.settingsManager = {
            config: {
                contracts: new Map([['contract1', {
                    type: ContractTypes.ORACLE,
                    contractId: 'contract1',
                    dataSource: 'exchanges',
                    baseAsset: new Asset(2, 'USD')
                }]])
            },
            getAssets
        }
        jest.useFakeTimers() //the TradesManager constructor starts a cleanup timer
        const tm = new CurrentTradesManager()
        tm.__loadDataForAssetMap = jest.fn()
        try {
            tm.loadTradesData(7 * 60 * 1000)
        } finally {
            tm.stop()
            container.settingsManager = original
            jest.clearAllTimers()
            jest.useRealTimers()
        }
        expect(getAssets).toHaveBeenCalledWith('contract1', 7 * 60 * 1000)
        expect(tm.__loadDataForAssetMap).toHaveBeenCalledTimes(1)
    })
})

describe('the local key list once expiry is evaluated at a tick', () => {
    const minute = 60 * 1000
    const self = 'self-node'
    const peer = 'peer-a'

    /**
     * @returns {object} a settings manager with one oracle on exchanges/USD whose only asset is expired, and whose
     * getAssets throws unless it is given an integer timestamp, as SettingsManager.getAssets does after Step 3
     */
    function makeSettings() {
        const {Asset, ContractTypes} = require('@reflector/reflector-shared')
        const nodes = new Map([[self, {pubkey: self}], [peer, {pubkey: peer}]])
        return {
            appConfig: {publicKey: self, dbSyncDelay: 0},
            config: {
                nodes,
                contracts: new Map([['oracle', {contractId: 'oracle', type: ContractTypes.ORACLE, dataSource: 'exchanges', baseAsset: new Asset(2, 'USD')}]])
            },
            nodes,
            getPriceHeartbeat: () => 2 * 60 * minute,
            getAssets: jest.fn((contractId, timestamp) => {
                if (!Number.isInteger(timestamp))
                    throw new Error('Timestamp is required to evaluate asset expiration')
                return [null]
            })
        }
    }

    test('a peer item for a key this node reads opens its sync entry on arrival, and nothing is logged as an error', () => {
        const {container, CurrentTradesManager} = requireCurrentModules()
        const logger = require('../../../src/logger')
        const now = 100_000 * minute
        const ts = now - minute
        const original = container.settingsManager
        container.settingsManager = makeSettings()
        logger.error.mockClear()
        jest.useFakeTimers({now})
        let tm = null
        try {
            tm = new CurrentTradesManager()
            tm.addSyncData(peer, {
                exchanges_USD: {
                    [ts]: {
                        assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: [{type: 2, code: 'BTC'}]},
                        trades: [[{volume: '1', quoteVolume: '2', source: 'binance'}]]
                    }
                }
            })

            expect(logger.error).not.toHaveBeenCalled()
            expect(logger.error).not.toHaveBeenCalledWith(expect.objectContaining({msg: 'Failed to build the local cache keys'}))
            expect(container.settingsManager.getAssets).toHaveBeenCalledWith('oracle', now)
            //the contract's only asset is expired and its key is still read: expiry empties a map, it never drops a key
            expect(tm.__timestamps.get(ts).get('exchanges_USD')).toBeDefined()
        } finally {
            tm?.stop()
            container.settingsManager = original
            jest.clearAllTimers()
            jest.useRealTimers()
        }
    })
})
