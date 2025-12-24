const {buildOracleInitTransaction, isTimestampValid, buildOraclePriceUpdateTransaction, getOracleContractState, ContractTypes} = require('@reflector/reflector-shared')
const statisticsManager = require('../statistics-manager')
const container = require('../container')
const {getPricesForContract} = require('../prices/price-manager')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const RunnerBase = require('./runner-base')

const DEFAULT_CACHE_SIZE = 3

class OracleRunner extends RunnerBase {
    constructor(contractId, type) {
        if (!contractId)
            throw new Error('contractId is required')
        super(contractId)
        this.__oracleType = type
    }

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
            && !this.__isTxExpired(timestamp, this.__delay)) {

            const prices = await getPricesForContract(this.contractId, timestamp)

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

    get __timeframe() {
        const {timeframe} = this.__getCurrentContract()
        return timeframe
    }

    __getNextTimestamp(currentTimestamp) {
        return currentTimestamp + Math.min(1000 * 60, this.__timeframe / 2) //1 minute or half of timeframe (whichever is smaller)
    }

    get __delay() {
        return 20 * 1000
    }

    get __contractType() {
        return this.__oracleType || ContractTypes.ORACLE
    }
}

module.exports = OracleRunner