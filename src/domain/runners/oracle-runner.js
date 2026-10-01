const {buildOracleInitTransaction, isTimestampValid, buildOraclePriceUpdateTransaction, getOracleContractState, ContractTypes, normalizeTimestamp, getContractEntries, Asset} = require('@reflector/reflector-shared')
const statisticsManager = require('../statistics-manager')
const container = require('../container')
const {getPricesForContract} = require('../prices/price-manager')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const {getPriceDiff} = require('../../utils/price-utils')
const RunnerBase = require('./runner-base')

const DEFAULT_CACHE_SIZE = 3
//the contract keeps at most 255 price updates, so the history window is at most 255 timeframes
const MAX_PRICES_CACHE_SIZE = 255

class OracleRunner extends RunnerBase {
    constructor(contractId, type) {
        if (!contractId)
            throw new Error('contractId is required')
        super(contractId)
        this.__oracleType = type
    }

    __lastLoadedEntries = new Map()

    __historyLoadFailed = false

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
        const assets = settingsManager.getAssets(this.contractId, timestamp)
        //evaluated once, so the skip log below reports exactly what the guard saw; __isTxExpired reads the clock
        const timestampValid = isTimestampValid(timestamp, timeframe)
        const txExpired = this.__isTxExpired(timestamp, this.__delay)
        const activeAssets = assets.filter(a => !!a).length

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
        } else if (timestampValid
            && contractState.lastTimestamp < timestamp
            && !txExpired
            && activeAssets > 0) {

            const prices = await this.__getPricesToUpdate(
                await getPricesForContract(this.contractId, timestamp),
                timestamp,
                settingsManager.getPriceHeartbeat(),
                timeframe,
                assets
            )
            if (prices.filter(price => price !== 0n).length === 0) {
                logger.trace({msg: 'No prices to update', contract: this.contractId, timestamp})
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
            //name the guard that stopped the update; a silent skip here would be indistinguishable from a healthy idle tick
            logger.debug({
                msg: 'No oracle update for this tick',
                ...this.__contractInfo,
                timestamp,
                timestampValid,
                lastTimestamp: Number(contractState.lastTimestamp),
                txExpired,
                activeAssets
            })
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
     * Applies the heartbeat fill-in and the per-asset threshold to the fetched prices. Both decisions read only the
     * entries this tick loaded from the chain, never per-process state, so every honest node reaches the same payload.
     * @param {bigint[]} prices - Array of fetched prices
     * @param {number} timestamp - Current timestamp
     * @param {number} heartbeat - Heartbeat interval
     * @param {number} timeframe - Timeframe for price updates
     * @param {Asset[]} assets - Array of assets
     * @returns {Promise<bigint[]>} - Updated prices
     * @throws {Error} when this tick's history load failed, so the node abstains
     */
    async __getPricesToUpdate(prices, timestamp, heartbeat, timeframe, assets) {
        if (this.__oracleType === ContractTypes.ORACLE)
            return prices

        await this.__loadPriceUpdateHistory(timestamp, timeframe, heartbeat)
        //no reference this tick: abstain rather than sign a payload the nodes that could read the history will not
        if (this.__historyLoadFailed)
            throw new Error('Price history load failed; abstaining from this tick')
        const lastPrices = this.__getLastOnChainPrices(assets.length)
        //read from this tick's load only: when the chain drops an entry newer than the boundary while an older one
        //survives (a lowered period shortens the TTL of later writes), a node that remembered it would take the threshold
        //branch while a restarted node takes the heartbeat branch - two payloads
        const descOrderedTimestamps = [...this.__lastLoadedEntries.keys()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)
        //Heartbeat retry: publish a heartbeat-style update as soon as we notice a
        //gap past the most recent heartbeat boundary, not only at the boundary tick.
        //An empty load (nothing on chain within the window) also counts as a gap.
        const mostRecentLoaded = descOrderedTimestamps[0]
        const isHeartbeatUpdate = mostRecentLoaded === undefined || mostRecentLoaded < normalizeTimestamp(timestamp, heartbeat)
        logger.trace({msg: 'Checking price updates', contract: this.contractId, timestamp, isHeartbeatUpdate, heartbeat, mostRecentLoaded})

        for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
            if (!assets[assetIndex]) //asset is not active
                continue
            if (isHeartbeatUpdate) { //current price or prev price (fall back to 0n so the filter below stays honest)
                prices[assetIndex] = prices[assetIndex] || lastPrices[assetIndex]?.price || 0n
                continue
            }
            if (!prices[assetIndex])
                continue //we can't calc diff if no price present
            const lastPrice = lastPrices[assetIndex]?.price
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

    /**
     * Loads this tick's on-chain price updates over the history window. The whole window is requested every tick and
     * nothing is kept from earlier ticks, so a freshly restarted node and a long-running node decide the per-asset
     * threshold and the heartbeat from the same entries.
     * @param {number} timestamp - tick timestamp
     * @param {number} timeframe - contract timeframe in milliseconds
     * @param {number} heartbeat - configured price heartbeat in milliseconds
     * @returns {Promise<void>}
     */
    async __loadPriceUpdateHistory(timestamp, timeframe, heartbeat) {
        this.__historyLoadFailed = false //set again below only if this tick's load fails
        //the contract keeps at most MAX_PRICES_CACHE_SIZE updates, so a heartbeat longer than that many timeframes is clamped.
        //The effective heartbeat is therefore min(heartbeat, 255 timeframes): an entry older than the window is invisible
        //to every node alike, so all of them take the heartbeat branch together - deterministic, but shorter than configured
        const historyWindow = Math.min(heartbeat, MAX_PRICES_CACHE_SIZE * timeframe)
        //the reference window is requested in full on every tick, so a long-running node and a restarted node compare
        //against the same entries and decide the threshold alike
        const referenceDepth = Math.min(MAX_PRICES_CACHE_SIZE, Math.ceil(historyWindow / timeframe))
        let currentChunk = []
        const timestampsToLoad = [currentChunk]
        for (let i = 1; i <= referenceDepth; i++) {
            currentChunk.push({key: timestamp - i * timeframe, type: 'u64', persistent: false})
            //split to batches of 200, because of rpc limits on number of entries to load in one request;
            //no batch is opened after the last key, so the rpc never receives an empty request
            if (currentChunk.length === 200 && i < referenceDepth) {
                currentChunk = []
                timestampsToLoad.push(currentChunk)
            }
        }

        const {settingsManager} = container
        const rpc = settingsManager.getBlockchainConnectorSettings()?.sorobanRpc
        if (!rpc)
            throw new Error('Soroban RPC not configured')
        let entries = {}
        try {
            for (const chunk of timestampsToLoad) {
                const chunkEntries = await getContractEntries(this.contractId, rpc, chunk)
                entries = {...entries, ...chunkEntries}
            }
        } catch (err) {
            //this node has no reference this tick, and publishing without one would sign a different payload from the
            //nodes that have it, so __getPricesToUpdate abstains
            logger.warn({msg: 'Failed to load price update history from RPC; this node abstains from the tick', err, contract: this.contractId})
            this.__historyLoadFailed = true
            entries = {}
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
        //record exactly what this tick loaded; the reference and the heartbeat decision are read from this set only, so
        //two nodes with different uptimes reach the same payload
        this.__lastLoadedEntries = new Map(Object.entries(entries).map(([key, value]) => [Number(key), restorePricesFromUpdate(value)]))
    }

    /**
     * The most recent non-zero on-chain price per asset index, taken from the entries this tick loaded from the
     * chain, never from anything an earlier tick loaded: two nodes with different uptimes must decide the threshold alike.
     * @param {number} assetsLength - number of assets configured for the contract
     * @returns {Array<{price: bigint, timestamp: number}|null>}
     */
    __getLastOnChainPrices(assetsLength) {
        const result = Array(assetsLength).fill(null)
        const loaded = this.__lastLoadedEntries || new Map()
        for (const ts of [...loaded.keys()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)) {
            const prices = loaded.get(ts)
            for (let i = 0; i < assetsLength; i++) {
                if (result[i])
                    continue
                const price = prices?.[i]
                if (price)
                    result[i] = {price, timestamp: ts}
            }
        }
        return result
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