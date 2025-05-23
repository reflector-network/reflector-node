/**
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TradeData} TradeData
 * @typedef {import('./trades-manager').Asset} Asset
 * @typedef {import('./assets-map')} AssetsMap
 */

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
            const assetInfo = this.assetsMap.getAssetInfo(asset?.code) //asset can be null, if it's expired
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
     * @param {Asset[]} assets - assets
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
     * @returns {Map<string, TimestampTradeData>}}
     */
    getTradesData(key, timestamp, assets) {
        //get all nodes data except the current node
        const data = [...this.__trades.keys()]
            .map(pubkey => [pubkey, this.__trades.get(pubkey).getTradesData(key, timestamp, assets)])
        const allNodesData = new Map(data)
        return allNodesData
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