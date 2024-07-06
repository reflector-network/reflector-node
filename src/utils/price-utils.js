/**
 * Get inversed price
 * @param {BigInt} price1 - price1 value
 * @param {BigInt} price2 - price2 value
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function calcCrossPrice(price1, price2, decimals) {
    if (price1 === BigInt(0) || price2 === BigInt(0))
        return BigInt(0)
    //check if price is BigInt
    if (typeof price1 !== 'bigint' || typeof price2 !== 'bigint')
        throw new TypeError('Price should be expressed as BigInt')
    const price = (price1 * (10n ** BigInt(decimals))) / price2
    return price
}

/**
 * Convert price to BigInt value with given decimals
 * @param {number} price - price value
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function getBigIntPrice(price, decimals) {
    price = Number(price)
    if (typeof price !== 'number' || isNaN(price))
        throw new Error('Price should be expressed as Number')
    if (typeof decimals !== 'number' || isNaN(decimals))
        throw new Error('Decimals should be expressed as Number')
    return BigInt(Math.round(price * Math.pow(10, decimals)))
}

/**
 * Calculate price from volume and quote volume
 * @param {number} volume - volume
 * @param {number} quoteVolume - quote volume
 * @param {number} decimals - number of decimals
 * @returns {BigInt}
 */
function getVWAP(volume, quoteVolume, decimals) {
    if (isNaN(volume) || isNaN(quoteVolume))
        return 0n
    const totalVolumeBigInt = getBigIntPrice(volume, decimals)
    const totalQuoteVolumeBigInt = getBigIntPrice(quoteVolume, decimals * 2) //multiply decimals by 2 to get correct price
    if (totalQuoteVolumeBigInt === 0n || totalVolumeBigInt === 0n)
        return 0n
    return totalQuoteVolumeBigInt / totalVolumeBigInt
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
    getBigIntPrice,
    calcCrossPrice,
    getVWAP,
    getMedianPrice
}