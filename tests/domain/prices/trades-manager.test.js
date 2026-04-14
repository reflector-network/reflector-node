/*eslint-disable no-undef */
const {Asset} = require('@reflector/reflector-shared')
const {getMajority} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const AssetMap = require('../../../src/domain/prices/assets-map')
const {getConcensusData} = require('../../../src/domain/prices/price-manager')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const logger = require('../../../src/logger')
const nodes = [
    {pubkey: 'node1'},
    {pubkey: 'node2'},
    {pubkey: 'node3'},
    {pubkey: 'node4'},
    {pubkey: 'node5'},
    {pubkey: 'node6'},
    {pubkey: 'node7'}
]


function getPrices(pricesCount, sourcesCount) {
    const prices = []
    for (let i = 1; i <= pricesCount; i++) {
        const price = []
        for (let j = 0; j < sourcesCount; j++) {
            //if (Math.random() > 0.9)
            //continue
            price.push({
                //volume: BigInt(i * Math.pow(10, 7)),
                //quoteVolume: BigInt(i * Math.pow(10, 7)) * (Math.random() > 0.9 ? BigInt(1000005378) : BigInt(1000000000 + i + j)),
                price: Math.random() > 0.9 ? BigInt(1000005378) : BigInt(1000000000 + i + j),
                source: `source${j}`,
                type: 'price'
            })
        }
        prices.push(price)
    }
    return prices
}
const originalStringify = JSON.stringify
JSON.stringify = function (value, replacer, space) {
    const customReplacer = (key, val) => {
        if (typeof val === 'bigint') {
            return val.toString()
        }
        return typeof replacer === 'function' ? replacer(key, val) : val
    }
    return originalStringify(value, customReplacer, space)
}

function normalizeTradeData(data, toString) {
    function normalizeValue(value) {
        return toString ? value.toString() : BigInt(value)
    }
    return data.map(assetTradeData =>
        assetTradeData.map(({ts, ...tradeData}) => {//we need ts only for debugging purposes, so we can remove it from the data that we send to sync
            if (tradeData.type === 'price') {
                tradeData.price = normalizeValue(tradeData.price, toString)
            } else {
                tradeData.volume = normalizeValue(tradeData.volume, toString)
                tradeData.quoteVolume = normalizeValue(tradeData.quoteVolume, toString)
            }
            return tradeData
        })
    )
}

describe('TradesManager', () => {

    it.skip('should reach majority', async () => {
        logger.setTrace(true)
        let reached = 0
        const totalSimsCount = 100
        for (let i = 0; i < totalSimsCount; i++) {
            const nodesData = []
            const timestamps = [11, 12, 13, 14, 15].map(ts => ts * 60 * 1000)
            const assetsMap = new AssetMap('test', new Asset(2, 'A1'), [new Asset(2, 'A2'), new Asset(2, 'A3'), new Asset(2, 'A4')])
            const key = `${assetsMap.source}_${assetsMap.baseAsset.code}`
            const plainMap = assetsMap.toPlainObject()
            for (let j = 0; j < nodes.length; j++) {
                for (const ts of timestamps) {
                    if (!nodesData[j]) {
                        nodesData[j] = {}
                        nodesData[j][key] = {}
                    }
                    nodesData[j][key][ts] = {
                        assetsMap: plainMap,
                        trades: normalizeTradeData(getPrices(assetsMap.assets.length, 1), true)
                    }
                }
            }

            const nodeResults = []

            for (let j = 0; j < nodes.length; j++) {
                container.settingsManager = {
                    appConfig: {publicKey: nodes[j].pubkey},
                    config: {
                        nodes: new Set(nodes)
                    },
                    nodes: new Map(nodes.map(node => [node.pubkey, {pubkey: node.pubkey}]))
                }
                container.tradesManager = new TradesManager()
                for (let k = 0; k < nodesData.length; k++) {
                    container.tradesManager.addSyncData(nodes[j].pubkey, nodesData[k])
                }

                const res = await getConcensusData(
                    assetsMap.source,
                    assetsMap.baseAsset,
                    assetsMap.assets,
                    timestamps[timestamps.length - 1],
                    5 * 60 * 1000
                )
                nodeResults.push(res)
            }
            const equalResults = nodeResults.filter(arr => JSON.stringify(arr) === JSON.stringify(nodeResults[0]))

            const hasMajority = equalResults.length >= getMajority(nodes.length)

            reached += hasMajority ? 1 : 0
            const result = []
            for (const t of equalResults[0]) {
                result.push(t.map(asset => asset.map(trade => trade.source).join(',')))
            }
            if (!hasMajority) {
                console.log(JSON.stringify(nodesData))
            }
            console.log(i)
        }
        console.log(`Reached majority in ${reached} out of ${totalSimsCount} sims`)
    }, 300000000)
})