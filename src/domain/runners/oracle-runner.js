const {buildOracleInitTransaction, isTimestampValid, buildOraclePriceUpdateTransaction, getOracleContractState, ContractTypes, normalizeTimestamp, getContractEntries, Asset} = require('@reflector/reflector-shared')
const statisticsManager = require('../statistics-manager')
const container = require('../container')
const {getPricesForContract} = require('../prices/price-manager')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const {getPriceDiff} = require('../../utils/price-utils')
const RunnerBase = require('./runner-base')

const DEFAULT_CACHE_SIZE = 3
//Cache keeps up to 255 most-recent on-chain price entries; entries older than
//MAX_PRICES_CACHE_SIZE * timeframe are pruned by __loadPriceUpdateHistory.
const MAX_PRICES_CACHE_SIZE = 255

class OracleRunner extends RunnerBase {
    constructor(contractId, type) {
        if (!contractId)
            throw new Error('contractId is required')
        super(contractId)
        this.__oracleType = type
    }

    __pricesCache = new Map()

    async __workerFn(timestamp) {
        const contractConfig = this.__getCurrentContract()

        const {settingsManager} = container

        const {timeframe, admin, fee: baseFee} = contractConfig

        //cluster network data
        const {networkPassphrase: network, sorobanRpc} = settingsManager.getBlockchainConnectorSettings()

        //get account info
        const sourceAccount = await getAccount(admin, sorobanRpc)

        const contractState = await getOracleContractState(
            this.contractId,
            sorobanRpc,
            sourceAccount,
            {
                networkPassphrase: network,
                fee: baseFee,
                timebounds: {minTime: 0, maxTime: 0}
            }
        )

        const protocol = contractState.protocol || (contractState.version >= 6 ? 2 : 1)

        logger.trace({msg: 'Contract state', lastTimestamp: Number(contractState.lastTimestamp), initialized: contractState.isInitialized, ...this.__contractInfo})
        statisticsManager.setLastOracleData(
            this.contractId,
            Number(contractState.lastTimestamp),
            contractState.isInitialized,
            this.__contractType
        )
        settingsManager.setAssetExpiration(this.contractId, contractState.expiration)
        const assets = settingsManager.getAssets(this.contractId)

        let updateTxBuilder = null
        if (!contractState.isInitialized) {
            updateTxBuilder = async (account, fee, maxTime) => await buildOracleInitTransaction({
                account,
                network,
                sorobanRpc,
                config: contractConfig,
                fee,
                maxTime,
                decimals: settingsManager.getDecimals(this.contractId),
                cacheSize: contractConfig.cacheSize ?? DEFAULT_CACHE_SIZE,
                protocol
            })
        } else if (isTimestampValid(timestamp, timeframe)
            && contractState.lastTimestamp < timestamp
            && !this.__isTxExpired(timestamp, this.__delay)
            && assets.some(a => !!a)) {

            const prices = await this.__getPricesToUpdate(
                await getPricesForContract(this.contractId, timestamp),
                timestamp,
                settingsManager.getPriceHeartbeat(),
                timeframe,
                assets
            )
            if (prices.filter(price => price !== 0n).length === 0) {
                logger.trace({msg: 'No prices to update', contractId: this.contractId, timestamp})
                return false //no prices to update
            }

            updateTxBuilder = async (account, fee, maxTime) => await buildOraclePriceUpdateTransaction({
                account,
                network,
                sorobanRpc,
                admin,
                prices,
                timestamp,
                contractId: this.contractId,
                fee,
                maxTime,
                protocol
            })
        } else {
            //nothing to do
            return false
        }

        await this.__buildAndSubmitTransaction(
            updateTxBuilder,
            sourceAccount,
            baseFee,
            timestamp,
            this.__delay
        )

        return true
    }

    /**
     *
     * @param {bigint[]} prices - Array of fetched prices
     * @param {bigint} timestamp - Current timestamp
     * @param {number} heartbeat - Heartbeat interval
     * @param {number} timeframe - Timeframe for price updates
     * @param {Asset[]} assets - Array of assets
     * @returns {Promise<bigint[]>} - Updated prices
     */
    async __getPricesToUpdate(prices, timestamp, heartbeat, timeframe, assets) {
        if (this.__oracleType === ContractTypes.ORACLE)
            return prices

        await this.__loadPriceUpdateHistory(timestamp, timeframe)
        const descOrderedTimestamps = [...this.__pricesCache.keys()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)
        //Heartbeat retry: publish a heartbeat-style update as soon as we notice a
        //gap past the most recent heartbeat boundary, not only at the boundary tick.
        //An empty cache (fresh restart + dormant contract) also counts as a gap.
        const mostRecentCached = descOrderedTimestamps[0]
        const isHeartbeatUpdate = mostRecentCached === undefined || mostRecentCached < normalizeTimestamp(timestamp, heartbeat)
        logger.trace({msg: 'Checking price updates', contractId: this.contractId, timestamp, isHeartbeatUpdate, heartbeat, mostRecentCached})

        const getLastPrice = (assetIndex) => {
            for (const ts of descOrderedTimestamps) {
                const price = this.__pricesCache.get(ts)?.[assetIndex]
                if (price)
                    return price
            }
        }
        for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
            if (!assets[assetIndex]) //asset is not active
                continue
            if (isHeartbeatUpdate) { //current price or prev price (fall back to 0n so the filter below stays honest)
                prices[assetIndex] = prices[assetIndex] || getLastPrice(assetIndex) || 0n
                continue
            }
            if (!prices[assetIndex])
                continue //we can't calc diff if no price present
            const lastPrice = getLastPrice(assetIndex)
            if (!lastPrice)
                continue //we can't calc diff if no last price present

            const priceDiff = getPriceDiff(lastPrice, prices[assetIndex])
            const threshold = assets[assetIndex]?.threshold || 0
            //skip price update if price change is less than threshold
            if (priceDiff < threshold)
                prices[assetIndex] = 0n
        }
        return prices
    }

    async __loadPriceUpdateHistory(timestamp, timeframe) {
        let currentChunk = []
        const timestampsToLoad = [currentChunk]
        const lowerTimestamp = timestamp - 1000 * 60 * 60 * 2 //2 hours
        for (let i = 1; i < MAX_PRICES_CACHE_SIZE; i++) {
            const ts = timestamp - i * timeframe
            currentChunk.push({key: ts, type: 'u64', persistent: false})
            if (this.__pricesCache.has(ts) || ts < lowerTimestamp)
                break
            if (currentChunk.length === 200) { //split to batches of 200, because of rpc limits on number of entries to load in one request
                currentChunk = []
                timestampsToLoad.push(currentChunk)
            }
        }

        const {settingsManager} = container
        const rpc = settingsManager.getBlockchainConnectorSettings()?.sorobanRpc
        if (!rpc)
            throw new Error('Soroban RPC not configured')
        let entries = {}
        for (const chunk of timestampsToLoad) {
            const chunkEntries = await getContractEntries(this.contractId, rpc, chunk)
            entries = {...entries, ...chunkEntries}
        }

        function restorePricesFromUpdate(update) {
            const prices = []
            let priceIndex = 0

            for (let byte = 0; byte < 32; byte++) {
                const maskByte = update.mask[byte]
                if (maskByte === 0)
                    continue

                for (let bit = 0; bit < 8; bit++) {
                    if (maskByte & (1 << bit)) {
                        const assetIndex = byte * 8 + bit
                        //Fill gaps with zeros
                        while (prices.length < assetIndex)
                            prices.push(0n)
                        prices.push(update.prices[priceIndex++])
                    }
                }
            }

            return prices
        }
        //update prices cache
        for (const [key, value] of Object.entries(entries)) {
            const prices = restorePricesFromUpdate(value)
            this.__pricesCache.set(Number(key), prices)
        }

        //remove stale entries — anything older than MAX_PRICES_CACHE_SIZE timeframes.
        //Age-based eviction (not size-based) so stale cache from before a long
        //dormancy can't linger in memory and diverge between restarted/non-restarted
        //nodes.
        const minAllowedTimestamp = timestamp - MAX_PRICES_CACHE_SIZE * timeframe
        for (const ts of this.__pricesCache.keys()) {
            if (ts < minAllowedTimestamp)
                this.__pricesCache.delete(ts)
        }
    }

    get __timeframe() {
        const {timeframe} = this.__getCurrentContract()
        return timeframe
    }

    __getNextTimestamp(currentTimestamp) {
        return currentTimestamp + Math.min(1000 * 60, this.__timeframe) //1 minute or the timeframe (whichever is smaller)
    }

    get __delay() {
        return 20 * 1000
    }

    get __contractType() {
        return this.__oracleType || ContractTypes.ORACLE
    }
}

module.exports = OracleRunner