const {buildOracleInitTransaction, isTimestampValid, buildOraclePriceUpdateTransaction, getContractState, ContractTypes} = require('@reflector/reflector-shared')
const statisticsManager = require('../statistics-manager')
const container = require('../container')
const {getPricesForContract} = require('../prices/price-manager')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const RunnerBase = require('./runner-base')

class OracleRunner extends RunnerBase {
    constructor(contractId) {
        if (!contractId)
            throw new Error('contractId is required')
        super(contractId)
    }

    async __workerFn(timestamp) {
        const contractConfig = this.__getCurrentContract()
        if (!contractConfig)
            throw new Error(`Config not found for oracle id: ${this.contractId}`)

        const {settingsManager} = container

        const {timeframe, admin, fee: baseFee} = contractConfig

        //cluster network data
        const {networkPassphrase: network, sorobanRpc} = settingsManager.getBlockchainConnectorSettings()

        //get account info
        const sourceAccount = await getAccount(admin, sorobanRpc)

        const contractState = await getContractState(this.contractId, sorobanRpc)

        logger.trace(`Contract state: lastTimestamp: ${Number(contractState.lastTimestamp)}, initialized: ${contractState.isInitialized}, contractId: ${this.contractId}`)
        statisticsManager.setLastOracleData(this.contractId, Number(contractState.lastTimestamp), contractState.isInitialized)

        let updateTxBuilder = null
        if (!contractState.isInitialized) {
            updateTxBuilder = async (account, fee, maxTime) => await buildOracleInitTransaction({
                account,
                network,
                sorobanRpc,
                config: contractConfig,
                fee,
                maxTime,
                decimals: settingsManager.getDecimals(this.contractId)
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
                maxTime
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
        return ContractTypes.ORACLE
    }
}

module.exports = OracleRunner