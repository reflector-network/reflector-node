/*eslint-disable no-undef */
const {Asset} = require('@reflector/reflector-shared')
const AssetsMap = require('../../../src/domain/prices/assets-map')
const container = require('../../../src/domain/container')
const Trades = require('../../../src/domain/prices/trades-cache')

function setupContainer(pubkey, nodes) {
    const nodesMap = new Map(nodes.map(n => [n, {pubkey: n}]))
    container.settingsManager = {
        appConfig: {publicKey: pubkey},
        getPriceHeartbeat: () => 2 * 60 * 60 * 1000, //2 hours -> 120 entries max
        nodes: nodesMap
    }
}

function makeAssetsMap(source, baseCode, assetCodes) {
    return new AssetsMap(source, new Asset(2, baseCode), assetCodes.map(c => new Asset(2, c)))
}

function makeTrades(assetCount) {
    const trades = []
    for (let i = 0; i < assetCount; i++) {
        trades.push([{price: BigInt(1000000 + i), source: 'src1', type: 'price'}])
    }
    return trades
}

describe('Trades', () => {
    const key = 'exchanges_USD'
    const timestamp = 60000

    beforeEach(() => {
        setupContainer('node1', ['node1', 'node2', 'node3'])
    })

    describe('setNodes', () => {
        test('removes data for nodes not in the provided list', () => {
            const trades = new Trades()
            const assetsMap = makeAssetsMap('exchanges', 'USD', ['BTC'])

            trades.push('node1', key, assetsMap, timestamp, makeTrades(1))
            trades.push('node2', key, assetsMap, timestamp, makeTrades(1))
            trades.push('node3', key, assetsMap, timestamp, makeTrades(1))

            trades.setNodes(['node1', 'node3'])

            const result = trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')])
            expect(result.has('node1')).toBe(true)
            expect(result.has('node2')).toBe(false)
            expect(result.has('node3')).toBe(true)
        })

        test('keeps all nodes when all are in the list', () => {
            const trades = new Trades()
            const assetsMap = makeAssetsMap('exchanges', 'USD', ['BTC'])

            trades.push('node1', key, assetsMap, timestamp, makeTrades(1))
            trades.push('node2', key, assetsMap, timestamp, makeTrades(1))

            trades.setNodes(['node1', 'node2', 'node3'])

            const result = trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')])
            expect(result.size).toBe(2)
        })

        test('removes all nodes when given empty list', () => {
            const trades = new Trades()
            const assetsMap = makeAssetsMap('exchanges', 'USD', ['BTC'])

            trades.push('node1', key, assetsMap, timestamp, makeTrades(1))
            trades.push('node2', key, assetsMap, timestamp, makeTrades(1))

            trades.setNodes([])

            //node1 gets re-created by __currentNodeTrades via getTradesData -> getLastTimestamp etc.
            //but the underlying map should be empty for node2
            expect(trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')]).has('node2')).toBe(false)
        })
    })

    describe('getTradesData - node filtering', () => {
        test('excludes data from nodes not in settingsManager.nodes', () => {
            const trades = new Trades()
            const assetsMap = makeAssetsMap('exchanges', 'USD', ['BTC'])

            trades.push('node1', key, assetsMap, timestamp, makeTrades(1))
            trades.push('node2', key, assetsMap, timestamp, makeTrades(1))
            trades.push('removed_node', key, assetsMap, timestamp, makeTrades(1))

            const result = trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')])
            expect(result.has('node1')).toBe(true)
            expect(result.has('node2')).toBe(true)
            expect(result.has('removed_node')).toBe(false)
        })

        test('reflects nodes changes dynamically', () => {
            const trades = new Trades()
            const assetsMap = makeAssetsMap('exchanges', 'USD', ['BTC'])

            trades.push('node1', key, assetsMap, timestamp, makeTrades(1))
            trades.push('node2', key, assetsMap, timestamp, makeTrades(1))

            //initially both visible
            let result = trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')])
            expect(result.size).toBe(2)

            //remove node2 from settings
            setupContainer('node1', ['node1'])

            result = trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')])
            expect(result.size).toBe(1)
            expect(result.has('node1')).toBe(true)
        })
    })

    describe('getTradesData - shallow copy', () => {
        test('returned trade objects are copies, not references to cached data', () => {
            const trades = new Trades()
            const assetsMap = makeAssetsMap('exchanges', 'USD', ['BTC'])

            trades.push('node1', key, assetsMap, timestamp, makeTrades(1))

            const result1 = trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')])
            const tradeData1 = result1.get('node1')

            //mutate the returned data
            tradeData1[0][0].price = 999n

            //fetch again — should be unaffected
            const result2 = trades.getTradesData(key, timestamp, [new Asset(2, 'BTC')])
            const tradeData2 = result2.get('node1')

            expect(tradeData2[0][0].price).toBe(1000000n)
        })
    })
})
