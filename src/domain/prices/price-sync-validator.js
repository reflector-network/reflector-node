const minute = 60 * 1000
const maxSyncKeys = 64 //cache keys accepted from one PRICE_SYNC message
//No connector puts more than one entry per provider into an asset's row - the exchanges and fx connectors have six
//providers each, the Stellar connector collapses every source into one entry - and no subscription or outage adds
//any, so no honest row comes near this. A peer's row is copied and scanned once per local source on every read of
//its asset, and every subscription on an asset reads it once per tick: without the bound one frame-sized row of about
//32,000 entries makes each of those reads cost about 2.7 ms, against 0.3 ms for the costliest item the bound leaves.
const maxSources = 32
const maxCodeLength = 80 //a Stellar CODE:ISSUER code is at most 12 + 1 + 56 = 69; an AssetType.OTHER code at most 32
//An honest volume can pass 40 digits: the Stellar connector restates an i128 pool reserve (up to 39 digits) at 14
//decimals, up to 10^14 more for a token that declares 0 decimals, uses a constant-product pool's reserves as volumes
//as they are, and may restate them again through a pool price and a cross-asset rate, and every honest node then
//sends the same long value for every minute. Those steps stay under 100 digits; the bound sits an order
//of magnitude above them and exists only to cap what one peer value costs in BigInt() at ingest and in toString()
//in getConcensusData's mismatch log: under 0.03 ms at 1000 digits, against 80 ms and 200 ms at the 1M digits a frame
//could otherwise carry.
const maxVolumeDigits = 1000
const decimalPattern = new RegExp(`^(0|[1-9][0-9]{0,${maxVolumeDigits - 1}})$`)

/**
 * The asset code check is deliberately no stricter than what an honest node can put into an assets map. The shared
 * `Asset` model (`reflector-shared/models/assets/asset.js`) constrains an `AssetType.OTHER` code only by
 * `code.length <= 32` - any characters - and a STELLAR code is `XLM`, a `C...` contract strkey, or `CODE:ISSUER`.
 * Subscription tickers reach the map as well, as OTHER assets, so the check only bounds the length. Nothing here
 * depends on the characters: the key binding in `validatePriceSyncItem` is an exact string equality, and pino escapes control
 * characters when it serialises a log line.
 * @param {any} value - candidate asset
 * @returns {{type: number, code: string}} the asset rebuilt with only the fields the cache reads
 */
function validateAsset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('asset must be an object')
    if (!Number.isInteger(value.type))
        throw new Error('asset type must be an integer')
    if (typeof value.code !== 'string' || value.code.length > maxCodeLength)
        throw new Error('asset code is invalid')
    return {type: value.type, code: value.code}
}

/**
 * @param {any} value - candidate trade entry
 * @returns {{volume: string, quoteVolume: string, source: (string|undefined)}} the entry rebuilt with only known fields
 */
function validateTrade(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('trade must be an object')
    if (typeof value.volume !== 'string' || !decimalPattern.test(value.volume))
        throw new Error('trade volume must be a decimal integer string')
    if (typeof value.quoteVolume !== 'string' || !decimalPattern.test(value.quoteVolume))
        throw new Error('trade quoteVolume must be a decimal integer string')
    const trade = {volume: value.volume, quoteVolume: value.quoteVolume}
    //the Stellar connector emits rows with no source at all, so an absent one is legitimate
    if (value.source !== undefined) {
        if (typeof value.source !== 'string')
            throw new Error('trade source must be a string')
        trade.source = value.source
    }
    return trade
}

/**
 * Validates one peer-supplied cache item and rebuilds it field by field, so nothing a peer invents survives into the
 * price path and nothing malformed can throw when the item is read later. A field of the wrong JSON type
 * needs no check of its own: reading a property of null, or calling map() on anything but an array, throws here, and
 * the caller rejects the item whatever the error.
 * @param {string} key - `<source>_<baseAssetCode>` cache key from the message
 * @param {number} timestamp - timestamp in milliseconds, parsed from the message
 * @param {any} item - raw `{assetsMap, trades}` entry
 * @param {number} now - local clock reading in milliseconds
 * @param {number} priceHeartbeat - retention window in milliseconds
 * @returns {{assetsMap: {source: *, baseAsset: {type: number, code: string}, assets: Array.<{type: number, code: string}>}, trades: Array.<Array.<object>>}} the item rebuilt with only the fields the cache reads
 */
function validatePriceSyncItem(key, timestamp, item, now, priceHeartbeat) {
    if (timestamp % minute !== 0)
        throw new Error('timestamp is not minute-aligned')
    const syncWindow = getSyncWindow(now, priceHeartbeat)
    if (timestamp > syncWindow.to)
        throw new Error('timestamp is in the future')
    if (timestamp < syncWindow.from)
        throw new Error('timestamp is outside the retention window')
    const rawMap = item.assetsMap
    const baseAsset = validateAsset(rawMap.baseAsset)
    //The key is the identity of the payload, so it has to be exactly what this payload would produce. The source is
    //otherwise not checked: a peer item is only ever read through the key it is filed under and the codes of its
    //assets, never through its source, so whatever spells a key is as good as the string that spells it.
    if (key !== `${rawMap.source}_${baseAsset.code}`)
        throw new Error('key does not match the payload')
    //No cap on the number of assets: a map holds the configured and subscribed assets of its source.
    const codes = new Set()
    const assets = rawMap.assets.map(rawAsset => {
        const asset = validateAsset(rawAsset)
        if (codes.has(asset.code))
            throw new Error('duplicate asset code')
        codes.add(asset.code)
        return asset
    })
    //An honest row can be shorter than the map and can have holes, but is never longer. The exchanges
    //connector pivots provider results into tradesData[minute][asset] and creates an asset's slot only when some
    //provider returned candles for it; a pair no provider returned complete candles for within three tries returns []
    //and gets no slot. The row therefore ends at the last asset with any data: every asset after it is absent, and
    //every asset before it with no data is a hole, which JSON sends as null. The upstream is shared, so every honest
    //node sends the same short or holed row for the same minute, and rejecting it loses the minute cluster-wide for
    //every contract on the map. So a missing trailing entry and a null entry both mean exactly one thing: that asset
    //carries no data. No node sends anything else in an asset's place. The fx and Stellar connectors size every row
    //to the map.
    if (item.trades.length > assets.length)
        throw new Error('trades is longer than the assets list')
    const trades = item.trades.map(rawRow => {
        if (rawRow === null) //a hole: no data for this asset
            return []
        if (rawRow.length > maxSources)
            throw new Error('too many sources in a trades row')
        return rawRow.map(validateTrade)
    })
    //a missing trailing asset carries no data: pad it with an empty row, so reading it yields [] from this peer
    //instead of throwing on the absent index
    while (trades.length < assets.length)
        trades.push([])
    return {assetsMap: {source: rawMap.source, baseAsset, assets}, trades}
}

/**
 * The timestamps a peer item is accepted for: at most one minute ahead of the local clock, and no older
 * than the heartbeat retention plus one minute.
 * @param {number} now - local clock reading in milliseconds
 * @param {number} priceHeartbeat - retention window in milliseconds
 * @returns {{from: number, to: number}} inclusive bounds in milliseconds
 */
function getSyncWindow(now, priceHeartbeat) {
    return {from: now - priceHeartbeat - minute, to: now + minute}
}

/**
 * How many timestamps one key of a PRICE_SYNC message may carry: every minute the sync window can hold, once. The
 * window spans the heartbeat plus two minutes, both ends included, so it holds at most floor(heartbeat / 1 min) + 3
 * minute-aligned timestamps. An honest sender on the same heartbeat carries at most floor(heartbeat / 1 min) per key,
 * because NodeTradesCache.push trims each key to that count. Derived rather than fixed because priceHeartbeat has no
 * upper bound: a fixed 256 would drop an honest reconnect backfill whole above a 256-minute heartbeat.
 * @param {number} priceHeartbeat - retention window in milliseconds
 * @returns {number} the largest number of timestamps accepted for one key of one message
 */
function getMaxSyncTimestamps(priceHeartbeat) {
    return Math.floor(priceHeartbeat / minute) + 3
}

module.exports = {validatePriceSyncItem, getSyncWindow, getMaxSyncTimestamps, maxSyncKeys, maxVolumeDigits}
