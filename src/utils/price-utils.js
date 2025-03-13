/**
 * Get сross price
 * @param {BigInt} quoteAssetPrice - quote asset price
 * @param {BigInt} baseAssetPrice - base asset price
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function calcCrossPrice(quoteAssetPrice, baseAssetPrice, decimals) {
    if (quoteAssetPrice === BigInt(0) || baseAssetPrice === BigInt(0))
        return BigInt(0)
    //check if price is BigInt
    if (typeof quoteAssetPrice !== 'bigint' || typeof baseAssetPrice !== 'bigint')
        throw new TypeError('Price should be expressed as BigInt')
    const price = (quoteAssetPrice * (10n ** BigInt(decimals))) / baseAssetPrice
    return price
}

/**
 * Convert value to BigInt with specified number of decimals
 * @param {BigInt} value - value
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function getPreciseValue(value, decimals) {
    if (typeof value !== 'bigint')
        throw new Error('Value should be expressed as BigInt')
    if (typeof decimals !== 'number' || isNaN(decimals))
        throw new Error('Decimals should be expressed as Number')
    if (value === 0n)
        return 0n
    return value * (10n ** BigInt(decimals))
}

/**
 * Calculate price from volume and quote volume
 * @param {BigInt} volume - volume
 * @param {BigInt} quoteVolume - quote volume
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function getVWAP(volume, quoteVolume, decimals) {
    const totalVolumeBigInt = getPreciseValue(volume, decimals)
    const totalQuoteVolumeBigInt = getPreciseValue(quoteVolume, decimals * 2) //multiply decimals by 2 to get correct price
    if (totalQuoteVolumeBigInt === 0n || totalVolumeBigInt === 0n)
        return 0n
    return totalQuoteVolumeBigInt / totalVolumeBigInt
}

/**
 * Normalize price. The prices from providers are a BigInt with 7 decimals.
 * @param {BigInt} price - price
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function normalizePrice(price, decimals) {
    if (decimals > 7) {
        return price * (BigInt(10) ** BigInt(decimals - 7))
    } else if (decimals < 7) {
        return price / (BigInt(10) ** BigInt(7 - decimals))
    }
    return price
}

/**
 * Calculate price from sum and number of entries
 * @param {BigInt} sum - sum of prices
 * @param {number} entries - number of entries
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function getAveragePrice(sum, entries, decimals) {
    if (entries === 0)
        return 0n
    return normalizePrice(sum, decimals) / BigInt(entries)
}

/**
 * @param {BigInt[]} range - list of prices
 * @return {BigInt}
 */
function getMedianPrice(range) {
    function median(range) { //calculates median value from the range of values
        const middle = Math.floor(range.length / 2)
        if (range.length % 2)
            return range[middle]
        return (range[middle - 1] + range[middle]) / 2n
    }

    //skip zeros
    range = range.filter(value => value > 0n)
    //store current range size
    const {length} = range
    //check if there's data to process
    if (!length)
        return null
    //sort array before applying median function
    range.sort((a, b) => Number(a - b))
    //calculate the median price
    let res = median(range)
    //filter out all outliers that deviate more than 4% from the median value
    range = range.filter(value => {
        let scaledRatio = 100n - 100n * value / res
        if (scaledRatio < 0n) {
            scaledRatio = -scaledRatio
        }
        return scaledRatio <= 4n
    })
    //recalculate the median if any outliers found
    if (range.length !== length && range.length > 1n) {
        res = median(range)
    }
    return res
}

module.exports = {
    getPreciseValue,
    calcCrossPrice,
    getVWAP,
    getAveragePrice,
    getMedianPrice
}