/**
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TradeData} TradeData
 * @typedef {import('./trades-manager').Asset} Asset
 * @typedef {import('./assets-map')} AssetsMap
 */

const {hasMajority} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')

/**
 * @param {TimestampTradeData} data - aggregated trade data
 * @param {boolean} toString - direction of conversion
 * @returns {Object} - normalized trade data
 */

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

class TradesDataItem {

    /**
     * @param {AssetsMap} assetsMap - assets map
     * @param {TimestampTradeData} trades - trades
     */
    constructor(assetsMap, trades) {
        this.assetsMap = assetsMap
        this.trades = normalizeTradeData(trades)
    }

    /**
     * @type {AssetsMap}
     */
    assetsMap

    /**
     * @type {TimestampTradeData}
     */
    trades

    /**
     * @param {string[]} assets - assets
     * @returns {TimestampTradeData}
     */
    getTradesData(assets) {
        const tradesData = []
        for (const asset of assets) {
            const assetInfo = this.assetsMap.getAssetInfo(asset.code)
            if (assetInfo === undefined) {
                tradesData.push([]) //no data for the asset
                continue
            }
            const trade = this.trades[assetInfo.index]
            tradesData.push(trade)
        }
        return tradesData
    }

    /**
     * @returns {{assetsMap: {source: string, baseAsset: Asset, assets: Asset[]}, trades: TimestampTradeData}}
     */
    toPlainObject() {
        return {
            assetsMap: this.assetsMap.toPlainObject(),
            trades: normalizeTradeData(this.trades, true)
        }
    }
}

const cacheSize = 15

class NodeTradesCache {

    /**
     * @type {Map<string, Map<number, TradesDataItem>>}
     */
    __trades = new Map()

    /**
     * @param {string} key - key
     * @param {AssetsMap} assetsMap - assets map
     * @param {number} timestamp - timestamp
     * @param {TimestampTradeData} trades - trades
     * @returns {TradesDataItem} - new cache item
     */
    push(key, assetsMap, timestamp, trades) {

        if (!this.__trades.has(key))
            this.__trades.set(key, new Map())

        const cacheItem = new TradesDataItem(assetsMap, trades)
        const keyData = this.__trades.get(key)
        keyData.set(timestamp, cacheItem)

        const timestamps = this.__getSortedTimestamps(key)
        //remove old data
        while (timestamps.length > cacheSize) {
            keyData.delete(timestamps[0])
            timestamps.shift()
        }

        return cacheItem
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @param {string[]} assets - assets
     * @returns {TimestampTradeData}
     */
    getTradesData(key, timestamp, assets) {
        const cacheItem = this.__trades.get(key)?.get(timestamp)
        if (!cacheItem)
            return null
        return cacheItem.getTradesData(assets)
    }

    getFirstTimestamp(key) {
        const timestamps = this.__getSortedTimestamps(key)
        if (timestamps.length === 0)
            return 0
        return timestamps[0]
    }

    getLastTimestamp(key) {
        const timestamps = this.__getSortedTimestamps(key)
        if (timestamps.length === 0)
            return 0
        return timestamps[timestamps.length - 1]
    }

    isAssetInCache(key, timestamp, asset) {
        const cacheItem = this.__trades.get(key)?.get(timestamp)
        if (!cacheItem)
            return false
        return cacheItem.assetsMap.getAssetInfo(asset.code) !== undefined
    }

    getAll() {
        return new Map(this.__trades)
    }

    getKeys() {
        return [...this.__trades.keys()]
    }

    __getSortedTimestamps(key) {
        return [...(this.__trades.get(key)?.keys() || [])].sort((a, b) => a - b)
    }
}


class Trades {

    /**
     * @type {Map<string, NodeTradesCache>}
     */
    __trades = new Map()

    /**
     * @param {string} pubkey - node pubkey
     * @param {string} tradesKey - key
     * @param {AssetsMap} assetsMap - assets map
     * @param {number} timestamp - timestamp
     * @param {TimestampTradeData} trades - trades
     * @returns {TradesDataItem} - new cache item
     */
    push(pubkey, tradesKey, assetsMap, timestamp, trades) {
        this.__ensureNodeCache(pubkey)
        return this.__trades.get(pubkey).push(tradesKey, assetsMap, timestamp, trades)
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @param {string[]} assets - assets
     * @returns {TimestampTradeData}
     */
    getTradesData(key, timestamp, assets) {
        //reverse the data to have the latest data first
        //iterate over the pending data from current node. We will not validate the data from other nodes if it not present in the current node data
        const currentNodeData = this.__trades
            .get(container.settingsManager.appConfig.publicKey)
            .getTradesData(key, timestamp, assets)

        //no reason to validate the data if it's not present in the current node data
        if (!currentNodeData)
            return

        //get all nodes data except the current node
        const allNodesData = [...this.__trades.keys()]
            .filter(pubkey => pubkey !== container.settingsManager.appConfig.publicKey)
            .map(pubkey => [pubkey, this.__trades.get(pubkey).getTradesData(key, timestamp, assets)])

        //iterate over the assets data from the current node and validate it with the data from the other nodes
        const majorityData = []
        for (let assetIndex = 0; assetIndex < currentNodeData.length; assetIndex++) {
            const assetMajorityData = []
            majorityData.push(assetMajorityData)
            const assetData = currentNodeData[assetIndex]
            //iterate over the sources data for the asset
            for (const assetSourceData of assetData) {
                let verifiedCount = 1 //count the current node as verified
                //find the data for the source in the other nodes data
                for (const nodeData of allNodesData) {
                    const [pubkey, nodeTradeData] = nodeData
                    if (!nodeTradeData) {
                        logger.trace(`Data for source ${assetSourceData.source}, timestamp ${timestamp}, assetIndex ${assetIndex}, not found in node ${pubkey}`)
                        continue
                    }
                    const nodeAssetSourceData = nodeTradeData[assetIndex]?.find(d => d.source === assetSourceData.source)
                    if (!nodeAssetSourceData) {
                        logger.trace(`Data for source ${assetSourceData.source}, timestamp ${timestamp}, assetIndex ${assetIndex}, not found in node ${pubkey}`)
                        continue
                    } else if (
                        nodeAssetSourceData.type !== assetSourceData.type
                                || nodeAssetSourceData.price !== assetSourceData.price
                                || nodeAssetSourceData.quoteVolume !== assetSourceData.quoteVolume
                                || nodeAssetSourceData.volume !== assetSourceData.volume
                    ) {
                        logger.trace(`Data for source ${assetSourceData.source}, timestamp ${timestamp}, assetIndex ${assetIndex}, not matching in node ${pubkey}`)
                        continue
                    }
                    verifiedCount++
                }
                //if we have majority, push the data to the cache, otherwise skip it
                if (!hasMajority(container.settingsManager.config.nodes.size, verifiedCount)) {
                    logger.info(`Data for source ${assetSourceData.source}, timestamp ${timestamp}, assetIndex ${assetIndex}, not verified`)
                    continue
                }
                assetMajorityData.push(assetSourceData)
            }
        }
        logger.debug(`Verified data for key ${key}, timestamp ${timestamp}`)
        logger.debug(normalizeTradeData(majorityData, true))
        return majorityData
    }

    getAll() {
        return this.__currentNodeTrades?.getAll()
    }

    getLastTimestamp(key) {
        return this.__currentNodeTrades?.getLastTimestamp(key) || 0
    }

    getFirstTimestamp(key) {
        return this.__currentNodeTrades?.getFirstTimestamp(key) || 0
    }

    /**
     * returns the first timestamp from all the keys for the current node
     * @returns {number}
     */
    getAbsoluteFirstTimestamp() {
        const keys = this.__currentNodeTrades.getKeys()
        if (keys.length === 0)
            return 0
        let firstTimestamp = Number.MAX_SAFE_INTEGER
        for (const key of keys) {
            const timestamp = this.getFirstTimestamp(key)
            if (timestamp < firstTimestamp)
                firstTimestamp = timestamp
        }
        if (firstTimestamp === Number.MAX_SAFE_INTEGER)
            return 0
        return firstTimestamp
    }

    get __currentNodeTrades() {
        this.__ensureNodeCache(container.settingsManager.appConfig.publicKey)
        return this.__trades.get(container.settingsManager.appConfig.publicKey)
    }

    __ensureNodeCache(pubkey) {
        if (!this.__trades.has(pubkey))
            this.__trades.set(pubkey, new NodeTradesCache())
    }
}

module.exports = Trades