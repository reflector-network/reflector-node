/*eslint-disable no-undef */
const {Asset} = require('@reflector/reflector-shared')
const AssetsMap = require('../domain/prices/assets-map')
const TradesManager = require('../domain/prices/trades-manager')

function makeAssetsMap(source, baseCode, assetCodes) {
    return new AssetsMap(source, new Asset(2, baseCode), assetCodes.map(c => new Asset(2, c)))
}

function flushPromises() {
    return new Promise(resolve => jest.requireActual('timers').setImmediate(resolve))
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
