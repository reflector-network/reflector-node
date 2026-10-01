/**
 * @typedef {import('./trades-manager').TimestampTradeData} TimestampTradeData
 * @typedef {import('./trades-manager').AssetTradeData} AssetTradeData
 * @typedef {import('./trades-manager').TradeData} TradeData
 * @typedef {import('./trades-manager').Asset} Asset
 * @typedef {import('./assets-map')} AssetsMap
 */

const container = require('../container')
const logger = require('../../logger')

const minute = 60 * 1000
const maxKeysPerNode = 32 //distinct cache keys one node may hold; a legitimate cluster uses a handful
//Keys and minutes alone do not bound what a peer holds: one frame-sized item of bare assets costs about 3.7 MB of
//heap, so 32 keys x 121 minutes of them would come to about 14 GB per member. The budget bounds the sum of
//estimateItemBytes over everything one peer holds. Measured with one member filling every key and minute, the
//retained heap came to 50-103 MB across the item shapes tried (bare assets, long volumes, long ASCII sources, CJK
//sources and CJK codes), so one member holds at most about 105 MB; strings are charged at two bytes a character so a
//CJK string cannot double that. A generous honest peer - four keys of 100 assets with six exchanges each, every
//minute of a 2-hour heartbeat - is estimated at 57 MB, and an overflow evicts its oldest minutes first, which no read
//of a short timeframe reaches.
//Keeping only the rows of the asset codes this node reads would bound it tighter, but that is not payload-neutral:
//during an asset addition the nodes that switch late drop rows the early ones keep, and the two sides then agree on
//different samples for the new asset (measured: 2 payloads per tick where keeping every row gives 1).
const maxPeerCacheBytes = 96 * 1024 * 1024
const itemOverheadBytes = 256
const assetOverheadBytes = 96 //the asset object, its code string and the row padded for it
const entryOverheadBytes = 136 //the entry object, two BigInts and the source string, before their contents
const stringBytesPerChar = 2 //the most V8 stores per character of a string
const defaultPriceHeartbeat = 2 * 60 * 60 * 1000 //the default SettingsManager.getPriceHeartbeat falls back to

/**
 * The heartbeat every cache bound is derived from. The shared config accepts Infinity (JSON 1e400), and a non-finite
 * heartbeat switches off every bound computed from it, so anything but a finite positive number falls back to the
 * default heartbeat.
 * @returns {number} retention window in milliseconds
 */
function getRetentionHeartbeat() {
    const heartbeat = Number(container.settingsManager.getPriceHeartbeat())
    return Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : defaultPriceHeartbeat
}

/**
 * @param {TimestampTradeData} data - aggregated trade data
 * @param {boolean} toString - direction of conversion
 * @returns {Object} - normalized trade data
 */

function normalizeTradeData(data, toString) {
    function normalizeValue(value) {
        return toString ? value.toString() : BigInt(value)
    }
    //rows can be sparse when a provider returned nothing for an asset, and Array.prototype.map preserves holes, so the
    //result is built explicitly and a hole becomes an empty row
    const normalized = []
    const rows = Array.isArray(data) ? data : []
    for (let i = 0; i < rows.length; i++) {
        const assetTradeData = rows[i]
        if (!Array.isArray(assetTradeData)) {
            normalized.push([])
            continue
        }
        const row = []
        for (const entry of assetTradeData) {
            if (!entry || typeof entry !== 'object')
                continue
            const {ts, ...tradeData} = entry //we need ts only for debugging purposes, so we can remove it from the data that we send to sync
            tradeData.volume = normalizeValue(tradeData.volume)
            tradeData.quoteVolume = normalizeValue(tradeData.quoteVolume)
            row.push(tradeData)
        }
        normalized.push(row)
    }
    return normalized
}

/**
 * Heap an item is expected to take once cached, from the peer's own strings: a BigInt takes about 0.42 bytes per
 * decimal digit, counted here as half a byte. A string is charged two bytes per character, because V8 stores any string
 * holding a character past Latin-1 at two bytes each and a peer chooses its codes and sources freely; charging the
 * one byte an ASCII string takes let a peer hold twice the budget in CJK strings.
 * @param {AssetsMap} assetsMap - assets map of the item
 * @param {Array.<Array.<{volume: (string|BigInt), quoteVolume: (string|BigInt), source: string}>>} trades - trade rows
 * @returns {number} estimated bytes
 */
function estimateItemBytes(assetsMap, trades) {
    let bytes = itemOverheadBytes
    for (const asset of assetsMap.assets)
        bytes += assetOverheadBytes + stringBytesPerChar * (asset?.code?.length || 0)
    for (const row of Array.isArray(trades) ? trades : []) {
        if (!Array.isArray(row))
            continue
        for (const entry of row) {
            if (!entry || typeof entry !== 'object')
                continue
            const digits = String(entry.volume).length + String(entry.quoteVolume).length
            bytes += entryOverheadBytes + Math.ceil(digits / 2) + stringBytesPerChar * (typeof entry.source === 'string' ? entry.source.length : 0)
        }
    }
    return bytes
}

class TradesDataItem {

    /**
     * @param {AssetsMap} assetsMap - assets map
     * @param {TimestampTradeData} trades - trades
     */
    constructor(assetsMap, trades) {
        this.assetsMap = assetsMap
        const normalized = normalizeTradeData(trades)
        //keep one row per asset so a provider that omitted trailing assets does not shorten the item
        const assetCount = Array.isArray(assetsMap?.assets) ? assetsMap.assets.length : normalized.length
        while (normalized.length < assetCount)
            normalized.push([])
        this.trades = normalized
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
            const trade = assetInfo === undefined ? undefined : this.trades[assetInfo.index]
            if (!Array.isArray(trade)) { //no data for the asset, or a short or malformed entry
                tradesData.push([])
                continue
            }
            tradesData.push(trade.map(t => ({...t})))
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

class NodeTradesCache {

    /**
     * @param {string} pubkey - node the cache belongs to, for the log
     * @param {number} [maxBytes] - estimated bytes the node may hold; this node's own cache is not bounded
     */
    constructor(pubkey, maxBytes = Infinity) {
        this.__pubkey = pubkey
        this.__maxBytes = maxBytes
    }

    /**
     * @type {Map<string, Map<number, TradesDataItem>>}
     */
    __trades = new Map()

    /**
     * Estimated bytes of every item held, kept only when the cache is bounded
     * @type {number}
     */
    __bytes = 0

    /**
     * Estimated bytes of each item held, kept only when the cache is bounded
     * @type {Map<TradesDataItem, number>}
     */
    __itemBytes = new Map()

    __overBudgetLogged = false

    /**
     * @type {number} estimated bytes of every item held
     */
    get bytes() {
        return this.__bytes
    }

    /**
     * Newest timestamp held for each key. Trimming a key only ever removes its oldest entries, so this is the newest
     * timestamp ever pushed for the key since it was opened.
     * @type {Map<string, number>}
     */
    __newestTimestamps = new Map()

    /**
     * @param {string} key - key
     * @param {AssetsMap} assetsMap - assets map
     * @param {number} timestamp - timestamp
     * @param {TimestampTradeData} trades - trades
     * @returns {TradesDataItem} - new cache item
     */
    push(key, assetsMap, timestamp, trades) {

        let keyData = this.__trades.get(key)
        if (!keyData) {
            keyData = new Map()
            this.__trades.set(key, keyData)
        }

        const cacheItem = new TradesDataItem(assetsMap, trades)
        this.__deleteItem(key, timestamp)
        keyData.set(timestamp, cacheItem)
        if (Number.isFinite(this.__maxBytes)) {
            const itemBytes = estimateItemBytes(assetsMap, trades)
            this.__itemBytes.set(cacheItem, itemBytes)
            this.__bytes += itemBytes
        }
        const newest = this.__newestTimestamps.get(key)
        if (newest === undefined || timestamp > newest)
            this.__newestTimestamps.set(key, timestamp)

        const maxEntries = Math.max(1, Math.floor(getRetentionHeartbeat() / minute))
        const timestamps = this.__getSortedTimestamps(key)
        //drop everything outside the heartbeat window, so one stale entry cannot occupy a slot indefinitely
        const windowStart = timestamps[timestamps.length - 1] - (maxEntries * minute)
        for (const ts of timestamps)
            if (ts < windowStart)
                this.__deleteItem(key, ts)
        //remove old data
        const remaining = this.__getSortedTimestamps(key)
        while (remaining.length > maxEntries) {
            this.__deleteItem(key, remaining[0])
            remaining.shift()
        }

        //bound the keys one node may open. The key dropped is the one with the oldest newest data, ties
        //broken by the key string, so a key that stopped receiving data goes before any live one, and the choice
        //depends only on what the cache holds, never on the order the keys arrived in. The key just pushed is a
        //candidate too: a key staler than every key held does not displace one of them.
        if (this.__trades.size > maxKeysPerNode)
            this.__deleteKey(this.__getStalestKey())

        this.__enforceByteBudget()
        return cacheItem
    }

    /**
     * Evicts the oldest items, ties broken by the key string, until the cache is back within its byte budget. The order
     * depends only on what the cache holds, and the item just pushed is a candidate too, so an item older than
     * everything held evicts itself rather than newer data.
     */
    __enforceByteBudget() {
        if (this.__bytes <= this.__maxBytes)
            return
        const bytesBefore = this.__bytes
        const items = []
        for (const [key, keyData] of this.__trades)
            for (const timestamp of keyData.keys())
                items.push({key, timestamp})
        items.sort((a, b) => a.timestamp - b.timestamp || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        let evicted = 0
        for (const {key, timestamp} of items) {
            if (this.__bytes <= this.__maxBytes)
                break
            this.__deleteItem(key, timestamp)
            if (this.__trades.get(key).size === 0)
                this.__deleteKey(key)
            evicted++
        }
        //once per peer at warn, so an honest peer outgrowing the budget is visible without a busy one flooding the log
        const entry = {node: this.__pubkey, budget: this.__maxBytes, bytes: bytesBefore, evicted}
        if (this.__overBudgetLogged) {
            logger.debug({msg: 'Peer trades cache exceeds its byte budget, oldest items evicted', ...entry})
            return
        }
        this.__overBudgetLogged = true
        logger.warn({msg: 'Peer trades cache exceeds its byte budget, oldest items evicted; further evictions are logged at debug', ...entry})
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     */
    __deleteItem(key, timestamp) {
        const keyData = this.__trades.get(key)
        const item = keyData?.get(timestamp)
        if (!item)
            return
        keyData.delete(timestamp)
        const itemBytes = this.__itemBytes.get(item)
        if (itemBytes !== undefined) {
            this.__bytes -= itemBytes
            this.__itemBytes.delete(item)
        }
    }

    /**
     * @param {string} key - key
     */
    __deleteKey(key) {
        for (const timestamp of [...(this.__trades.get(key)?.keys() || [])])
            this.__deleteItem(key, timestamp)
        this.__trades.delete(key)
        this.__newestTimestamps.delete(key)
    }

    /**
     * Drops every key whose newest data is older than the horizon: a key nothing pushes any more, such as the key of a
     * removed contract, would otherwise stay for the node's uptime
     * @param {number} horizon - oldest timestamp still inside the retention window
     * @returns {number} number of keys removed
     */
    removeStaleKeys(horizon) {
        const staleKeys = []
        for (const [key, newest] of this.__newestTimestamps)
            if (newest < horizon)
                staleKeys.push(key)
        for (const key of staleKeys)
            this.__deleteKey(key)
        return staleKeys.length
    }

    /**
     * @returns {string} the key whose newest timestamp is the oldest, the smallest key string among equals
     */
    __getStalestKey() {
        let stalestKey
        let stalestTimestamp = Infinity
        for (const [key, newest] of this.__newestTimestamps) {
            if (newest < stalestTimestamp || (newest === stalestTimestamp && key < stalestKey)) {
                stalestKey = key
                stalestTimestamp = newest
            }
        }
        return stalestKey
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

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @returns {boolean} whether an item is cached for the key at the timestamp
     */
    hasData(key, timestamp) {
        return this.__trades.get(key)?.has(timestamp) || false
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
        const allNodesData = new Map()
        for (const pubkey of this.__trades.keys()) {
            if (!container.settingsManager.nodes.has(pubkey)) //make sure that we don't get data from removed node
                continue
            let nodeData = null
            try {
                nodeData = this.__trades.get(pubkey).getTradesData(key, timestamp, assets)
            } catch (err) {
                //one peer's entry must never stop the price computation for the whole cluster
                logger.debug({msg: 'Failed to read cached trades data for node', node: pubkey, key, timestamp, err: err.message})
                nodeData = null
            }
            allNodesData.set(pubkey, nodeData)
        }
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
     * @param {string} pubkey - node public key
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @returns {boolean} whether the node's cache holds an item for the key at the timestamp
     */
    hasData(pubkey, key, timestamp) {
        return this.__trades.get(pubkey)?.hasData(key, timestamp) || false
    }

    /**
     * @param {string} key - key
     * @param {number} timestamp - timestamp
     * @returns {string[]} pubkeys of the nodes whose cache holds an item for the key at the timestamp
     */
    getNodesWithData(key, timestamp) {
        const pubkeys = []
        for (const [pubkey, nodeCache] of this.__trades)
            if (nodeCache.hasData(key, timestamp))
                pubkeys.push(pubkey)
        return pubkeys
    }

    /**
     * Drops, for every node, the keys whose newest data is older than the horizon
     * @param {number} horizon - oldest timestamp still inside the retention window
     * @returns {number} number of keys removed
     */
    removeStaleKeys(horizon) {
        let removed = 0
        for (const nodeCache of this.__trades.values())
            removed += nodeCache.removeStaleKeys(horizon)
        return removed
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

    /**
     * Set the nodes for which to cache trades data
     * @param {string[]} nodes - node pubkeys
     */
    setNodes(nodes) {
        const nodeKeys = this.__trades.keys()
        for (const pubkey of nodeKeys) {
            if (nodes.indexOf(pubkey) === -1) {
                this.__trades.delete(pubkey) //remove old nodes
            }
        }
    }

    get __currentNodeTrades() {
        this.__ensureNodeCache(container.settingsManager.appConfig.publicKey)
        return this.__trades.get(container.settingsManager.appConfig.publicKey)
    }

    __ensureNodeCache(pubkey) {
        if (this.__trades.has(pubkey))
            return
        const isCurrentNode = pubkey === container.settingsManager?.appConfig?.publicKey
        this.__trades.set(pubkey, new NodeTradesCache(pubkey, isCurrentNode ? Infinity : maxPeerCacheBytes))
    }
}

module.exports = Trades
module.exports.getRetentionHeartbeat = getRetentionHeartbeat
module.exports.estimateItemBytes = estimateItemBytes
module.exports.maxPeerCacheBytes = maxPeerCacheBytes