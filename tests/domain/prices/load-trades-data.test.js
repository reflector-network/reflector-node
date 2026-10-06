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
            appConfig: {publicKey: self},
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

describe('connector fetch budget', () => {
    afterEach(() => {
        //in a finally-shaped hook, not after the assertion: a failing assertion would leak fake timers into every
        //later test in this file
        jest.useRealTimers()
        jest.dontMock('../../../src/domain/data-sources-manager')
        jest.dontMock('../../../src/domain/nodes/nodes-manager')
        jest.resetModules()
    })

    test('a connector that never answers is abandoned at the budget', async () => {
        jest.resetModules()
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData: () => new Promise(() => {})}})
        }))
        const container = require('../../../src/domain/container')
        const {Asset} = require('@reflector/reflector-shared')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
        const dataSourcesManager = require('../../../src/domain/data-sources-manager')

        const originalSettings = container.settingsManager
        container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
        jest.useFakeTimers()
        try {
            //loadPriceData is the unit the deadline was added to; drive it directly
            const attempt = TradesManagerReloaded.__loadPriceData(
                dataSourcesManager.get('exchanges'), new Asset(2, 'USD'), [new Asset(2, 'BTC')], 60_000, 1
            )
            const assertion = expect(attempt).rejects.toThrow('timed out after 90000 ms')
            await jest.advanceTimersByTimeAsync(90_001)
            await assertion
        } finally {
            container.settingsManager = originalSettings
        }
    })

    test('a connector that answers in time is not disturbed', async () => {
        jest.resetModules()
        const rows = [[[{volume: 1n, quoteVolume: 1n, source: 'binance'}]]]
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData: () => Promise.resolve(rows)}})
        }))
        const container = require('../../../src/domain/container')
        const {Asset} = require('@reflector/reflector-shared')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
        const dataSourcesManager = require('../../../src/domain/data-sources-manager')

        const originalSettings = container.settingsManager
        container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
        try {
            await expect(TradesManagerReloaded.__loadPriceData(
                dataSourcesManager.get('exchanges'), new Asset(2, 'USD'), [new Asset(2, 'BTC')], 60_000, 1
            )).resolves.toBe(rows)
        } finally {
            container.settingsManager = originalSettings
        }
    })

    test('a key whose abandoned call has not settled is not fetched again until it does', async () => {
        jest.resetModules()
        const late = []
        const getPriceData = jest.fn(() => new Promise(resolve => late.push(resolve)))
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData}})
        }))
        const container = require('../../../src/domain/container')
        const {Asset} = require('@reflector/reflector-shared')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
        const dataSourcesManager = require('../../../src/domain/data-sources-manager')

        const originalSettings = container.settingsManager
        container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
        jest.useFakeTimers()
        try {
            const load = () => TradesManagerReloaded.__loadPriceData(dataSourcesManager.get('exchanges'), new Asset(2, 'USD'), [new Asset(2, 'BTC')], 60_000, 1)
            const first = expect(load()).rejects.toThrow('timed out after 90000 ms')
            await jest.advanceTimersByTimeAsync(90_001)
            await first

            //the abandoned call is still running: the next tick does not start a second one for the key
            await expect(load()).rejects.toThrow('the previous request has not settled')
            expect(getPriceData).toHaveBeenCalledTimes(1)

            //once it settles, the key is fetched again
            late[0]([])
            await jest.advanceTimersByTimeAsync(0)
            const third = load()
            expect(getPriceData).toHaveBeenCalledTimes(2)
            late[1]([[]])
            await expect(third).resolves.toEqual([[]])
        } finally {
            container.settingsManager = originalSettings
        }
    })

    test('a call that never settles blocks its key for three budgets, not until a restart', async () => {
        jest.resetModules()
        const late = []
        const getPriceData = jest.fn(() => new Promise(resolve => late.push(resolve)))
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData}})
        }))
        const container = require('../../../src/domain/container')
        const logger = require('../../../src/logger')
        const {Asset} = require('@reflector/reflector-shared')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
        const dataSourcesManager = require('../../../src/domain/data-sources-manager')

        const originalSettings = container.settingsManager
        container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
        jest.useFakeTimers()
        try {
            const load = () => TradesManagerReloaded.__loadPriceData(dataSourcesManager.get('exchanges'), new Asset(2, 'USD'), [new Asset(2, 'BTC')], 60_000, 1)
            const first = expect(load()).rejects.toThrow('timed out after 90000 ms')
            await jest.advanceTimersByTimeAsync(90_001)
            await first

            //the first call never settles; one millisecond short of three budgets the key is still skipped
            await jest.advanceTimersByTimeAsync(3 * 90_000 - 90_001 - 1)
            await expect(load()).rejects.toThrow('the previous request has not settled')
            expect(getPriceData).toHaveBeenCalledTimes(1)

            await jest.advanceTimersByTimeAsync(1)
            const fetchedAgain = load()
            expect(getPriceData).toHaveBeenCalledTimes(2)
            expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({msg: expect.stringContaining('three fetch budgets')}))
            late[1]([[]])
            await expect(fetchedAgain).resolves.toEqual([[]])
        } finally {
            container.settingsManager = originalSettings
        }
    })

    describe('what settles a key', () => {
        /**
         * @param {function(object): Promise<any>} getPriceData - the connector's fetch
         * @returns {{load: function(string=): Promise<any>, restore: function()}} a loader for one base asset code
         */
        function loaderWith(getPriceData) {
            jest.resetModules()
            jest.doMock('../../../src/domain/data-sources-manager', () => ({
                get: () => ({name: 'exchanges', instance: {getPriceData}})
            }))
            const container = require('../../../src/domain/container')
            const {Asset} = require('@reflector/reflector-shared')
            const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
            const dataSourcesManager = require('../../../src/domain/data-sources-manager')
            const originalSettings = container.settingsManager
            container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
            const exchanges = dataSourcesManager.get('exchanges')
            return {
                load: (base = 'USD') => TradesManagerReloaded.__loadPriceData(exchanges, new Asset(2, base), [new Asset(2, 'BTC')], 60_000, 1),
                restore: () => {
                    container.settingsManager = originalSettings
                }
            }
        }

        test('a given-up call that settles late leaves the entry of the call that replaced it', async () => {
            const late = []
            const getPriceData = jest.fn(() => new Promise(resolve => late.push(resolve)))
            const {load, restore} = loaderWith(getPriceData)
            jest.useFakeTimers()
            try {
                const first = expect(load()).rejects.toThrow('timed out after 90000 ms')
                await jest.advanceTimersByTimeAsync(3 * 90_000)
                await first
                const second = expect(load()).rejects.toThrow('timed out after 90000 ms') //given up: the key is fetched again
                expect(getPriceData).toHaveBeenCalledTimes(2)

                late[0]([]) //the first call settles now, while the second is in flight
                await jest.advanceTimersByTimeAsync(0)

                await expect(load()).rejects.toThrow('the previous request has not settled')
                expect(getPriceData).toHaveBeenCalledTimes(2)
                await jest.advanceTimersByTimeAsync(90_001)
                await second
            } finally {
                restore()
            }
        })

        test('a connector that fails, or throws before it returns a promise, frees its key at once', async () => {
            let fail = () => Promise.reject(new Error('rate limited'))
            const getPriceData = jest.fn(options => fail(options))
            const {load, restore} = loaderWith(getPriceData)
            try {
                await expect(load()).rejects.toThrow('rate limited')
                fail = () => {
                    throw new Error('bad options')
                }
                await expect(load()).rejects.toThrow('bad options')
                fail = () => Promise.resolve([[]])
                await expect(load()).resolves.toEqual([[]])
                expect(getPriceData).toHaveBeenCalledTimes(3)
            } finally {
                restore()
            }
        })

        test('the three budgets are the derived budget of the call, not the 90 s floor', async () => {
            const getPriceData = jest.fn(() => new Promise(() => {}))
            jest.resetModules()
            jest.doMock('../../../src/domain/data-sources-manager', () => ({
                get: () => ({name: 'exchanges', instance: {getPriceData}})
            }))
            const container = require('../../../src/domain/container')
            const {Asset} = require('@reflector/reflector-shared')
            const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
            const dataSourcesManager = require('../../../src/domain/data-sources-manager')
            const originalSettings = container.settingsManager
            container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
            //100 pairs at batchSize 1 and batchDelay 1500 ms: a 195 s budget, so the key is held for 585 s
            const assets = Array.from({length: 100}, (_, i) => new Asset(2, `A${i}`))
            const load = () => TradesManagerReloaded.__loadPriceData(dataSourcesManager.get('exchanges'), new Asset(2, 'USD'), assets, 60_000, 1)
            jest.useFakeTimers()
            try {
                const first = expect(load()).rejects.toThrow('timed out after 195000 ms')
                await jest.advanceTimersByTimeAsync(3 * 90_000 + 1)
                await first
                await expect(load()).rejects.toThrow('the previous request has not settled')
                await jest.advanceTimersByTimeAsync(3 * 195_000 - (3 * 90_000 + 1) - 1)
                await expect(load()).rejects.toThrow('the previous request has not settled')
                expect(getPriceData).toHaveBeenCalledTimes(1)
                await jest.advanceTimersByTimeAsync(1)
                const again = expect(load()).rejects.toThrow('timed out after 195000 ms')
                expect(getPriceData).toHaveBeenCalledTimes(2)
                await jest.advanceTimersByTimeAsync(195_001)
                await again
            } finally {
                container.settingsManager = originalSettings
            }
        })

        test('an unsettled call blocks its own key only', async () => {
            const getPriceData = jest.fn(({baseAsset}) => (baseAsset === 'USD' ? new Promise(() => {}) : Promise.resolve([[]])))
            const {load, restore} = loaderWith(getPriceData)
            jest.useFakeTimers()
            try {
                const first = expect(load('USD')).rejects.toThrow('timed out after 90000 ms')
                await jest.advanceTimersByTimeAsync(90_001)
                await first

                await expect(load('USD')).rejects.toThrow('the previous request has not settled')
                await expect(load('EUR')).resolves.toEqual([[]])
                expect(getPriceData).toHaveBeenCalledTimes(2)
            } finally {
                restore()
            }
        })

        //exchanges and forex both default to a USD base, so a key without the source would let a hung exchanges call
        //hold forex USD for three budgets
        test('a hung exchanges USD call does not hold forex USD: the source is part of the key', async () => {
            const hung = jest.fn(() => new Promise(() => {}))
            const answers = jest.fn(() => Promise.resolve([[]]))
            const {restore} = loaderWith(hung)
            const {Asset} = require('@reflector/reflector-shared')
            const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
            const load = name => TradesManagerReloaded.__loadPriceData(
                {name, instance: {getPriceData: name === 'forex' ? answers : hung}}, new Asset(2, 'USD'), [new Asset(2, 'EUR')], 60_000, 1
            )
            jest.useFakeTimers()
            try {
                const first = expect(load('exchanges')).rejects.toThrow('timed out after 90000 ms')
                await jest.advanceTimersByTimeAsync(90_001)
                await first

                await expect(load('exchanges')).rejects.toThrow('the previous request has not settled')
                await expect(load('forex')).resolves.toEqual([[]])
                expect(hung).toHaveBeenCalledTimes(1)
                expect(answers).toHaveBeenCalledTimes(1)
            } finally {
                restore()
            }
        })
    })

    test('loadTradesDataForSource really reaches the fetch on a fresh cache', () => {
        //the end-to-end path depends on getSampleSize being non-zero; assert that rather than assuming it
        const {__getSampleSize} = require('../../../src/domain/prices/trades-manager')
        expect(__getSampleSize(0, 15 * 60 * 1000)).toBeGreaterThan(0)
    })

    test('a small map gets the 90 s floor', () => {
        const {__getPriceFetchTimeout} = require('../../../src/domain/prices/trades-manager')
        expect(__getPriceFetchTimeout(1, 1, 1500)).toBe(90_000)
        //30 batches of 1.5 s plus the 45 s margin is exactly the floor
        expect(__getPriceFetchTimeout(30, 1, 1500)).toBe(90_000)
    })

    test('a large map gets ceil(pairs / batchSize) x batchDelay + 45 s', () => {
        const {__getPriceFetchTimeout} = require('../../../src/domain/prices/trades-manager')
        expect(__getPriceFetchTimeout(100, 1, 1500)).toBe(195_000)
        //three usable gateways: 34 batches
        expect(__getPriceFetchTimeout(100, 3, 1500)).toBe(96_000)
        //the map has no cap, so the budget keeps growing with it
        expect(__getPriceFetchTimeout(60, 1, 1500)).toBe(135_000)
        expect(__getPriceFetchTimeout(200, 1, 1500)).toBe(345_000)
        expect(__getPriceFetchTimeout(1000, 1, 1500)).toBe(1_545_000)
    })

    test('loadPriceData gives a large map the derived budget, not the 90 s floor', async () => {
        jest.resetModules()
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData: () => new Promise(() => {})}})
        }))
        const container = require('../../../src/domain/container')
        const {Asset} = require('@reflector/reflector-shared')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
        const dataSourcesManager = require('../../../src/domain/data-sources-manager')

        const originalSettings = container.settingsManager
        //no gateways: the node passes batchSize 1 and batchDelay 1500 ms, so 100 pairs get 100 x 1.5 s + 45 s
        container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
        jest.useFakeTimers()
        try {
            const assets = Array.from({length: 100}, (_, i) => new Asset(2, `A${i}`))
            let outcome = 'pending'
            TradesManagerReloaded.__loadPriceData(dataSourcesManager.get('exchanges'), new Asset(2, 'USD'), assets, 60_000, 1)
                .catch(e => {
                    outcome = e.message
                })
            await jest.advanceTimersByTimeAsync(90_001)
            expect(outcome).toBe('pending')
            await jest.advanceTimersByTimeAsync(105_000)
            expect(outcome).toBe('Price data request for exchanges timed out after 195000 ms')
        } finally {
            container.settingsManager = originalSettings
        }
    })

    test('an answer that arrives after the budget is dropped, and nothing from it is cached or gossiped', async () => {
        jest.resetModules()
        const minute = 60 * 1000
        const now = 100_000 * minute
        const self = 'self-node'
        const key = 'exchanges_USD'
        const late = []
        const getPriceData = jest.fn(() => new Promise(resolve => late.push(resolve)))
        const broadcast = jest.fn(() => Promise.resolve())
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData}})
        }))
        jest.doMock('../../../src/domain/nodes/nodes-manager', () => ({broadcast, getConnectedNodes: () => [], sendTo: jest.fn()}))
        const container = require('../../../src/domain/container')
        const logger = require('../../../src/logger')
        const {Asset} = require('@reflector/reflector-shared')
        const AssetsMapReloaded = require('../../../src/domain/prices/assets-map')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')

        const originalSettings = container.settingsManager
        const nodes = new Map([[self, {pubkey: self}]])
        container.settingsManager = {
            appConfig: {publicKey: self},
            config: {nodes},
            nodes,
            gateways: {urls: null},
            getSimSource: () => undefined,
            getPriceHeartbeat: () => 2 * 60 * minute
        }
        jest.useFakeTimers({now})
        const tm = new TradesManagerReloaded()
        const makeMap = () => new AssetsMapReloaded('exchanges', new Asset(2, 'USD'), [new Asset(2, 'BTC')])
        try {
            tm.__loadDataForAssetMap(makeMap())
            expect(getPriceData).toHaveBeenCalledTimes(1)
            //a fresh cache asks for the full 15 minutes
            expect(getPriceData.mock.calls[0][0].count).toBe(15)

            await jest.advanceTimersByTimeAsync(89_999)
            expect(tm.__pendingTradesRequest.has(key)).toBe(true)
            await jest.advanceTimersByTimeAsync(2)

            //the fetch was abandoned through the existing catch, and the key is free for the next tick
            const failure = logger.error.mock.calls.find(([entry]) => entry.msg === 'Error loading prices for source')
            expect(failure[0].source).toBe('exchanges')
            expect(failure[0].err.message).toBe('Price data request for exchanges timed out after 90000 ms')
            expect(tm.__pendingTradesRequest.has(key)).toBe(false)

            //the connector now answers with a complete, well-formed result for every requested minute
            const rows = Array.from({length: 15}, () => [[{volume: 5n, quoteVolume: 10n, source: 'binance'}]])
            late[0](rows)
            await jest.advanceTimersByTimeAsync(0)

            //nothing from the late answer reached the cache, the sync map or the peers
            expect(tm.__trades.getLastTimestamp(key)).toBe(0)
            for (let i = 0; i < 15; i++)
                expect(tm.__trades.getNodesWithData(key, now - i * minute)).toEqual([])
            expect(tm.__timestamps.size).toBe(0)
            expect(broadcast).not.toHaveBeenCalled()

            //the next tick starts a fresh request for the key instead of queueing behind the abandoned one
            tm.__loadDataForAssetMap(makeMap())
            expect(getPriceData).toHaveBeenCalledTimes(2)
        } finally {
            tm.stop()
            container.settingsManager = originalSettings
        }
    })

    //a key held by an unsettled call is skipped every tick for up to three budgets; that is expected, so it is announced
    //once as a warning, followed at debug, never logged as an error with a stack, and its end is logged once
    test('a held key warns once across its skipped ticks and logs once when the hold ends', async () => {
        jest.resetModules()
        const minute = 60 * 1000
        const now = 100_000 * minute
        const self = 'self-node'
        const late = []
        const getPriceData = jest.fn(() => new Promise(resolve => late.push(resolve)))
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData}})
        }))
        jest.doMock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(() => Promise.resolve()), getConnectedNodes: () => [], sendTo: jest.fn()}))
        const container = require('../../../src/domain/container')
        const logger = require('../../../src/logger')
        const {Asset} = require('@reflector/reflector-shared')
        const AssetsMapReloaded = require('../../../src/domain/prices/assets-map')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')

        const originalSettings = container.settingsManager
        const nodes = new Map([[self, {pubkey: self}]])
        container.settingsManager = {
            appConfig: {publicKey: self},
            config: {nodes},
            nodes,
            gateways: {urls: null},
            getSimSource: () => undefined,
            getPriceHeartbeat: () => 2 * 60 * minute
        }
        jest.useFakeTimers({now})
        const tm = new TradesManagerReloaded()
        const makeMap = () => new AssetsMapReloaded('exchanges', new Asset(2, 'USD'), [new Asset(2, 'BTC')])
        const held = 'Price data request skipped: the previous request for the key has not settled'
        const released = 'The held connector call settled; the key is fetched again'
        const entries = (fn, msg) => fn.mock.calls.map(([entry]) => entry).filter(entry => entry?.msg === msg)
        const loadErrors = () => entries(logger.error, 'Error loading prices for source')
        try {
            logger.warn.mockClear()
            logger.error.mockClear()
            logger.debug.mockClear()
            logger.info.mockClear()
            tm.__loadDataForAssetMap(makeMap())
            await jest.advanceTimersByTimeAsync(90_001)
            //the abandoned fetch itself is an error, as before
            expect(loadErrors()).toHaveLength(1)
            expect(loadErrors()[0].err.message).toBe('Price data request for exchanges timed out after 90000 ms')

            //three one-minute ticks while the call is held (the hold lasts three 90 s budgets): one warning, the rest at
            //debug, no further error
            for (let tick = 0; tick < 3; tick++) {
                tm.__loadDataForAssetMap(makeMap())
                await jest.advanceTimersByTimeAsync(minute)
            }
            expect(getPriceData).toHaveBeenCalledTimes(1)
            expect(entries(logger.warn, held)).toEqual([expect.objectContaining({key: 'exchanges_USD'})])
            expect(entries(logger.warn, held)[0].err).toBeUndefined()
            expect(entries(logger.debug, held)).toHaveLength(2)
            expect(loadErrors()).toHaveLength(1)
            expect(entries(logger.info, released)).toHaveLength(0)

            //the call settles: the end of the hold is logged once, and the next tick fetches again
            late[0]([])
            await jest.advanceTimersByTimeAsync(0)
            expect(entries(logger.info, released)).toEqual([expect.objectContaining({key: 'exchanges_USD'})])
            tm.__loadDataForAssetMap(makeMap())
            expect(getPriceData).toHaveBeenCalledTimes(2)
            expect(entries(logger.warn, held)).toHaveLength(1)
            expect(entries(logger.info, released)).toHaveLength(1)
        } finally {
            tm.stop()
            container.settingsManager = originalSettings
        }
    })

    test('a call that settles without ever holding a key logs no end of hold', async () => {
        jest.resetModules()
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            get: () => ({name: 'exchanges', instance: {getPriceData: () => Promise.resolve([[]])}})
        }))
        const container = require('../../../src/domain/container')
        const logger = require('../../../src/logger')
        const {Asset} = require('@reflector/reflector-shared')
        const TradesManagerReloaded = require('../../../src/domain/prices/trades-manager')
        const dataSourcesManager = require('../../../src/domain/data-sources-manager')
        const originalSettings = container.settingsManager
        container.settingsManager = {gateways: {urls: null}, getSimSource: () => undefined}
        try {
            logger.info.mockClear()
            await TradesManagerReloaded.__loadPriceData(dataSourcesManager.get('exchanges'), new Asset(2, 'USD'), [new Asset(2, 'BTC')], 60_000, 1)
            await Promise.resolve()
            const released = logger.info.mock.calls.filter(([entry]) => entry?.msg === 'The held connector call settled; the key is fetched again')
            expect(released).toHaveLength(0)
        } finally {
            container.settingsManager = originalSettings
        }
    })
})
