/**
 * @typedef {import('./asset-map')} AssetMap
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TradeData} TradeData
 */

class TradesCacheItem {

    /**
     * @param {AssetMap} assetsMap - assets map
     * @param {TimestampTradeData} trades - trades
     */
    constructor(assetsMap, trades) {
        this.assetsMap = assetsMap
        this.trades = trades
    }

    /**
     * @type {AssetMap}
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
            const assetInfo = this.assetsMap.assets[asset.code]
            if (assetInfo === undefined) {
                tradesData.push(null)
                continue
            }
            const trade = this.trades[assetInfo.index]
            tradesData.push(trade)
        }
        return tradesData
    }
}

const maxLimit = 15

class TradesCache {

    /**
     * @type {Object.<string, Object.<number, TradesCacheItem>>}
     */
    __trades = {}

    /**
     * @param {string} key - key
     * @param {AssetMap} assetsMap - assets map
     * @param {number} timestamp - timestamp
     * @param {TimestampTradeData} trades - trades
     */
    push(key, assetsMap, timestamp, trades) {

        if (!this.__trades[key])
            this.__trades[key] = {}

        this.__trades[key][timestamp] = new TradesCacheItem(assetsMap, trades)

        const timestamps = Object.keys(this.__trades[key])
        //remove old data
        while (timestamps.length > maxLimit) {
            delete this.__trades[timestamps[0]]
            timestamps.shift()
        }
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @param {string[]} assets - assets
     * @returns {TimestampTradeData}
     */
    getTradesData(key, timestamp, assets) {
        const cacheItem = this.__trades[key]?.[timestamp]
        if (!cacheItem)
            return null
        return cacheItem.getTradesData(assets)
    }

    getLastTimestamp(key) {
        const timestamps = Object.keys(this.__trades[key] ?? {}).sort((a, b) => b - a)
        if (timestamps.length === 0)
            return 0
        return Number(timestamps[0])
    }
}

module.exports = TradesCache