const {buildInitTransaction, isTimestampValid, buildPriceUpdateTransaction, getContractState} = require('@reflector/reflector-shared')
const {retrieveAccountProps} = require('@reflector/reflector-db-connector')
const container = require('../container')
const {getPrices} = require('../price-provider')
const logger = require('../../logger')
const RunnerBase = require('./runner-base')

class OracleRunner extends RunnerBase {
    constructor(oracleId) {
        if (!oracleId)
            throw new Error('oracleId is required')
        super(oracleId)
    }

    async __workerFn(timestamp) {
        const contractConfig = this.__getCurrentContract()
        if (!contractConfig)
            throw new Error(`Config not found for oracle id: ${this.oracleId}`)

        const {baseAsset, decimals, timeframe, dataSource, admin, fee: baseFee} = contractConfig

        //cluster network data
        const {networkPassphrase: network, sorobanRpc} = this.__getBlockchainConnectorSettings()

        //get account info
        const sourceAccount = await this.__getAccount(admin, sorobanRpc)

        logger.trace(`OracleRunner -> __workerFn -> sourceAccount: ${sourceAccount.accountId()}: ${sourceAccount.sequenceNumber()}`)

        const contractState = await getContractState(this.oracleId, sorobanRpc)

        const {settingsManager, statisticsManager} = container

        logger.trace(`Contract state: lastTimestamp: ${Number(contractState.lastTimestamp)}, initialized: ${contractState.isInitialized}, oracleId: ${this.oracleId}}`)
        statisticsManager.setLastOracleData(this.oracleId, Number(contractState.lastTimestamp), contractState.isInitialized)

        let updateTxBuilder = null
        if (!contractState.isInitialized) {
            updateTxBuilder = async (account, fee, maxTime) => await buildInitTransaction({
                account,
                network,
                sorobanRpc,
                config: contractConfig,
                fee,
                maxTime
            })
        } else if (isTimestampValid(timestamp, timeframe) && contractState.lastTimestamp < timestamp) {
            const assets = settingsManager.getAssets(this.oracleId, true)
            const prevPrices = [...contractState.prices, ...Array(assets.length - contractState.prices.length).fill(0n)]

            const prices = await getPrices(
                dataSource,
                baseAsset,
                assets,
                decimals,
                (timestamp - timeframe) / 1000,
                timeframe / 1000,
                prevPrices
            )

            updateTxBuilder = async (account, fee, maxTime) => await buildPriceUpdateTransaction({
                account,
                network,
                sorobanRpc,
                admin,
                prices,
                timestamp,
                oracleId: this.oracleId,
                fee,
                maxTime
            })
        } else {
            //nothing to do
            return
        }

        await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseFee, timestamp + this.__dbSyncDelay)

        statisticsManager.incSubmittedTransactions(this.oracleId)
    }

    __getCurrentContract() {
        const {settingsManager} = container
        const contractConfig = settingsManager.getContractConfig(this.oracleId)
        if (!contractConfig)
            throw new Error(`Config not found for oracle id: ${this.oracleId}`)
        return contractConfig
    }

    get __timeframe() {
        const {timeframe} = this.__getCurrentContract()
        return timeframe
    }

    __getNextTimestamp(currentTimestamp) {
        return currentTimestamp + Math.min(1000 * 60, this.__timeframe / 2) //1 minute or half of timeframe (whichever is smaller)
    }

    get __dbSyncDelay() {
        return (container.settingsManager.appConfig.dbSyncDelay || 15) * 1000
    }
}

module.exports = OracleRunner