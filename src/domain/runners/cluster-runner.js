const {buildUpdateTransaction, normalizeTimestamp} = require('@reflector/reflector-shared')
const container = require('../container')
const {getAccount} = require('../../utils')
const RunnerBase = require('./runner-base')

const idleWorkerTimeframe = 1000 * 60 * 2 //2 minute

const baseUpdateFee = 10000000

function isPendingConfigExpired(pendingConfig) {
    return pendingConfig.timestamp < Date.now()
}

class ClusterRunner extends RunnerBase {

    async __workerFn(timestamp) {
        const {settingsManager} = container
        const {pendingConfig, config} = settingsManager
        if (!pendingConfig || pendingConfig.timestamp > Date.now())
            return

        const {sorobanRpc, networkPassphrase} = settingsManager.getBlockchainConnectorSettings()
        const sourceAccount = await getAccount(config.systemAccount, sorobanRpc)

        let hasMoreTxns = false

        const updateTxBuilder = async (account, fee, maxTime) => {
            const tx = await buildUpdateTransaction({
                timestamp: pendingConfig.timestamp,
                account,
                network: networkPassphrase,
                sorobanRpc,
                newConfig: pendingConfig.config,
                currentConfig: config,
                fee,
                maxTime
            })

            hasMoreTxns = tx?.hasMoreTxns || false
            return tx
        }

        const syncTimestamp = isPendingConfigExpired(pendingConfig)
            ? timestamp
            : pendingConfig.timestamp

        await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseUpdateFee, syncTimestamp)

        if (hasMoreTxns) //if true, the config has more transactions to be submitted
            return

        settingsManager.applyPendingUpdate()
    }

    __getNextTimestamp(currentTimestamp) {
        const {pendingConfig} = container.settingsManager
        if (!pendingConfig || this.__pendingTransaction || isPendingConfigExpired(pendingConfig))
            return normalizeTimestamp(currentTimestamp + idleWorkerTimeframe, idleWorkerTimeframe)
        return pendingConfig.timestamp
    }

    get __timeframe() {
        return idleWorkerTimeframe
    }
}

module.exports = ClusterRunner