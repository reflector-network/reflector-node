const {buildInitTransaction, isTimestampValid, buildPriceUpdateTransaction} = require('@reflector/reflector-shared')
const {retrieveAccountProps, retrieveContractState} = require('@reflector/reflector-db-connector')
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

        const {baseAsset, decimals, timeframe, dataSource, admin, fee} = contractConfig

        //cluster network data
        const {networkPassphrase: network, horizonUrl, blockchainConnector} = this.__getBlockchainConnectorSettings()

        //get account info
        const {sequence} = await retrieveAccountProps(blockchainConnector, admin)
        const account = this.__getAccount(admin, sequence)

        const contractState = await retrieveContractState(blockchainConnector, this.oracleId)

        const {settingsManager, statisticsManager} = container

        logger.debug(`Contract state: ${JSON.stringify({lastTimestamp: Number(contractState.lastTimestamp), uninitialized: contractState.uninitialized, oracleId: this.oracleId})}`)
        statisticsManager.setLastOracleData(this.oracleId, Number(contractState.lastTimestamp), !contractState.uninitialized)

        let tx = null
        if (contractState.uninitialized)
            tx = await buildInitTransaction({account, network, horizonUrl, config: contractConfig})
        else if (isTimestampValid(timestamp, timeframe) && contractState.lastTimestamp < timestamp) {
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
            tx = await buildPriceUpdateTransaction({
                account,
                network,
                horizonUrl,
                admin,
                prices,
                timestamp,
                oracleId: this.oracleId,
                fee
            })
        }

        if (tx) { //if transaction is built, set it as pending
            this.__setPendingTransaction(tx)
            await this.__trySubmitTransaction()
        }
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
        return currentTimestamp + this.__timeframe
    }
}

module.exports = OracleRunner