const {normalizeTimestamp, getOracleContractState} = require('@reflector/reflector-shared')
const {getTradesData} = require('@reflector/reflector-exchanges-connector')
const {aggregateTrades} = require('@reflector/reflector-db-connector')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const {getMedianPrice, getVWAP} = require('../utils/price-utils')
const DataSourceTypes = require('../models/data-source-types')
const dataSourcesManager = require('../domain/data-sources-manager')
const logger = require('../logger')
const container = require('./container')

/**
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

function getCount(lastTimestemp, targetTimestamp) {
    if (lastTimestemp >= targetTimestamp) {
        return 0
    }
    const computedCount = (targetTimestamp - lastTimestemp) / minute
    return Math.min(computedCount, maxLimit)
}

/**
 * @param {{volume: BigInt, quoteVolume: BigInt}[][]} volumes - volumes
 * @param {number} decimals - decimals
 * @param {BigInt[]} prevPrices - previous prices
 * @returns {BigInt[]}
 */
function calcPrice(volumes, decimals, prevPrices) {

    const prices = Array(volumes.length).fill(0n)
    for (let i = 0; i < volumes.length; i++) {
        const assetVolumes = volumes[i]
        const vwaps = assetVolumes.map(v => getVWAP(v.volume, v.quoteVolume, decimals))
        prices[i] = getMedianPrice(vwaps) || prevPrices[i]
    }

    return prices
}

const minute = 60
const minuteMs = minute * 1000
const maxLimit = 15

/**
 * @param {any} dataSource - source
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets
 * @param {number} from - from Unix timestamp
 * @param {number} count - count of items to load
 * @return {Promise<{volume: number, quoteVolume: number, source: string}[][]>}
 */
function loadTradesData(dataSource, baseAsset, assets, from, count) {
    switch (dataSource.type) {
        case DataSourceTypes.API:
            return loadApiTradesData(dataSource, baseAsset, assets, from, count)
        case DataSourceTypes.DB:
            return loadDbTradesData(dataSource, baseAsset, assets, from, count)
        default:
            throw new Error(`Data source ${dataSource.type} not supported`)
    }
}

/**
 *
 * @param {any} dataSource - source object
 * @param {Asset} baseAsset - base asset
 * @param {Asset[]} assets - assets
 * @param {number} from - timestamp
 * @param {number} count - count of items to load
 * @returns {Promise<{volume: number, quoteVolume: number, source: string}[][]>}
 */
async function loadApiTradesData(dataSource, baseAsset, assets, from, count) {
    switch (dataSource.name) {
        case 'exchanges': {
            const tradesData = await getTradesData(
                assets.map(asset => asset.code),
                baseAsset.code,
                from,
                minute,
                count
            )
            return tradesData
        }
        default:
            throw new Error(`Data source ${dataSource.name} not supported`)
    }
}

async function loadDbTradesData(dataSource, baseAsset, assets, from, count) {
    const {dbConnector} = dataSource
    const start = Date.now()
    const tradesData = await aggregateTrades({db: dbConnector, baseAsset, assets, from, period: minute, limit: count})
    const normalizedTrades = Array(assets.length).fill(null).map(() => [])
    for (let i = 0; i < assets.length; i++) {
        const assetTradesData = normalizedTrades[i]
        let ts = from
        for (let j = 0; j < tradesData.length; j++) {
            const tradeData = tradesData[j][i]
            tradeData.source = dataSource.name
            tradeData.ts = ts
            assetTradesData.push(tradeData)
            ts += minute
        }
        normalizedTrades[i] = [assetTradesData] //we need to wrap it in another array to match the structure of the API response
    }
    logger.info(`Loaded ${tradesData.length} trades data in ${Date.now() - start} ms`)

    return normalizedTrades
}


class PriceManager {

    /**
     * @type {Map<string, Map<number, {volume: number, quoteVolume: number, source: string}[][]>>}
     */
    tradesData = new Map()

    /**
     * @type {Map<string, Promise>}
     */
    requests = new Map()

    /**
     * @param {string} contractId - source
     * @param {number} timestamp - current timestamp
     * @param {number} timeframe - timeframe in milliseconds
     * @returns {Promise<BigInt[]>}
     */
    async getPrices(contractId, timestamp, timeframe = null) {
        const {settingsManager} = container
        const contract = settingsManager.getContractConfig(contractId)
        if (!contract)
            throw new Error(`Contract ${contractId} not found`)
        if (contract.type !== ContractTypes.ORACLE)
            throw new Error(`Contract ${contractId} is not an oracle contract`)

        const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
        //get contract state
        const contractState = await getOracleContractState(contractId, sorobanRpc)
        //get assets for the contract
        const assets = settingsManager.getAssets(contract.contractId, true)
        const prevPrices = [...contractState.prices, ...Array(assets.length - contractState.prices.length).fill(0n)]

        //wait for loading volumes
        await this.getTradesForContractPromise(contractId, timestamp)

        //normalize timestamp
        timestamp = timestamp / 1000
        //start of the current timeframe
        let currentVolumeTimestamp = timestamp - ((timeframe || contract.timeframe) / 1000) //default timeframe is contract timeframe
        //get volumes for the contract
        const contractVolumes = this.tradesData.get(contractId)
        const totalVolumes = Array(assets.length).fill(0n).map(() => new Map())
        while (currentVolumeTimestamp < timestamp) {
            const currentVolumes = contractVolumes.get(currentVolumeTimestamp)
            if (!currentVolumes) {
                throw new Error(`Volumes not found for timestamp ${currentVolumeTimestamp} for contract ${contractId}`)
            }
            for (let i = 0; i < assets.length; i++) {
                if (currentVolumes.length <= i) //if the asset was added recently, we don't have volumes for it yet
                    break
                const totalAssetVolumes = totalVolumes[i]
                for (const tradeData of currentVolumes[i]) {
                    let sourceTotalVolume = totalAssetVolumes.get(tradeData.source)
                    if (!sourceTotalVolume) {
                        sourceTotalVolume = {volume: 0n, quoteVolume: 0n}
                        totalAssetVolumes.set(tradeData.source, sourceTotalVolume)
                    }
                    if (tradeData.ts !== currentVolumeTimestamp) {
                        logger.warn(`Volume for source ${tradeData.source} not found for timestamp ${currentVolumeTimestamp} for contract ${contractId}`)
                    }
                    sourceTotalVolume.volume += tradeData.volume
                    sourceTotalVolume.quoteVolume += tradeData.quoteVolume
                }
            }
            currentVolumeTimestamp += minute
        }
        //compute price
        const prices = calcPrice(totalVolumes.map(v => [...v.values()]), contract.decimals, prevPrices)
        return prices
    }

    async loadTradesDataForContract(contractId, timestamp) {
        try {
            const {settingsManager} = container
            const contract = settingsManager.getContractConfig(contractId)
            if (!contract)
                throw new Error(`Contract ${contractId} not found`)
            if (contract.type !== ContractTypes.ORACLE)
                throw new Error(`Contract ${contractId} is not an oracle contract`)

            if (contract.timeframe % minuteMs !== 0) {
                throw new Error('Timeframe should be whole minutes')
            }
            const timeframe = contract.timeframe / minuteMs
            if (timeframe > 60) {
                throw new Error('Timeframe should be less than or equal to 60 minutes')
            }

            const currentNormalizedTimestamp = normalizeTimestamp(Date.now() / 1000, minute)
            const lastCompleteTimestamp = timestamp / 1000 - minute
            if (lastCompleteTimestamp % minute !== 0) {
                throw new Error('Timestamp should be whole minutes')
            } else if (lastCompleteTimestamp >= currentNormalizedTimestamp) {
                throw new Error('Timestamp should be less than current time')
            } else if (lastCompleteTimestamp < currentNormalizedTimestamp - minute * 60) {
                throw new Error('Timestamp should be within last 60 minutes')
            }

            let contractTradesData = this.tradesData.get(contractId)
            if (!contractTradesData) {
                contractTradesData = new Map()
                this.tradesData.set(contractId, contractTradesData)
            }

            const presentedTimestamps = [...contractTradesData.keys()]
            const lastTimestamp = presentedTimestamps.length > 0 ? presentedTimestamps[presentedTimestamps.length - 1] : 0

            const count = getCount(lastTimestamp, lastCompleteTimestamp)
            //if count is greater than 0, then we need to load volumes
            if (count === 0)
                return

            const from = lastCompleteTimestamp - ((count - 1) * minute)

            const dataSource = dataSourcesManager.get(contract.dataSource)
            const assets = settingsManager.getAssets(contract.contractId, true)
            //load volumes
            const tradesData = await loadTradesData(dataSource, contract.baseAsset, assets, from, count)

            //process volumes for each asset
            for (let i = 0; i < assets.length; i++) {
                const assetTradesData = tradesData[i]
                for (let j = 0; j < assetTradesData.length; j++) {
                    const providerTradesData = assetTradesData[j]
                    let currentTimestamp = from
                    for (let k = 0; k < providerTradesData.length; k++) {
                        let currentTimestampData = contractTradesData.get(currentTimestamp)
                        if (!currentTimestampData) {
                            currentTimestampData = Array(assets.length).fill(null)
                            contractTradesData.set(currentTimestamp, currentTimestampData)
                        }
                        if (!currentTimestampData[i])
                            currentTimestampData[i] = []

                        currentTimestampData[i].push(providerTradesData[k])
                        currentTimestamp = currentTimestamp + minute
                    }
                }
            }
        } catch (err) {
            logger.error({err}, `Error loading prices for contract ${contractId}`)
        }
    }

    async loadTradesData(timestamp) {
        const {settingsManager} = container
        const oracleContractIds = [...settingsManager.config.contracts.values()]
            .filter(c => c.type === ContractTypes.ORACLE)
            .map(c => c.contractId)
        const promises = []
        for (const contractId of oracleContractIds) {
            promises.push(this.getTradesForContractPromise(contractId, timestamp))
        }
        await Promise.all(promises)
    }

    getTradesForContractPromise(contractId, timestamp) {
        if (this.requests.has(contractId)) {
            return this.requests.get(contractId)
        }
        const promise = this.loadTradesDataForContract(contractId, timestamp)
            .then(() => {
                this.requests.delete(contractId)
            })

        this.requests.set(contractId, promise)
        return promise
    }
}

module.exports = new PriceManager()