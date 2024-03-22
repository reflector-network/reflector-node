const {buildUpdateTransaction, normalizeTimestamp} = require('@reflector/reflector-shared')
const {retrieveAccountProps} = require('@reflector/reflector-db-connector')
const container = require('../container')
const RunnerBase = require('./runner-base')

const idleWorkerTimeframe = 1000 * 60 //1 minute

const baseUpdateFee = 10000000

function isPendingConfigExpired(pendingConfig) {
    return (pendingConfig.timestamp + 60 * 1000) < Date.now()
}
class ClusteUpdatesRunner extends RunnerBase {

    async __workerFn(timestamp) {
        const {settingsManager} = container
        const {pendingConfig, config} = settingsManager
        if (!pendingConfig || pendingConfig.timestamp > Date.now())
            return

        const {sorobanRpc, blockchainConnector, networkPassphrase} = this.__getBlockchainConnectorSettings()
        const accountInfo = await retrieveAccountProps(blockchainConnector, config.systemAccount)
        const sourceAccount = this.__getAccount(config.systemAccount, accountInfo.sequence)

        const updateTxBuilder = async (account, fee, maxTime) => await buildUpdateTransaction({
            timestamp: pendingConfig.timestamp,
            account,
            network: networkPassphrase,
            sorobanRpc,
            newConfig: pendingConfig.config,
            currentConfig: config,
            fee,
            maxTime
        })

        const syncTimestamp = isPendingConfigExpired(pendingConfig)
            ? pendingConfig.timestamp
            : timestamp

        await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseUpdateFee, syncTimestamp)
    }

    __getNextTimestamp() {
        const {pendingConfig} = container.settingsManager
        if (!pendingConfig || this.__pendingTransaction || (pendingConfig.timestamp + 60 * 1000) < Date.now())
            return normalizeTimestamp(Date.now() + idleWorkerTimeframe, 1000)
        return pendingConfig.timestamp
    }

    get __timeframe() {
        return 1000 //1 second
    }
}

module.exports = ClusteUpdatesRunner