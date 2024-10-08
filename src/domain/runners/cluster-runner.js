const {buildUpdateTransaction, normalizeTimestamp, areAllSignaturesPresent} = require('@reflector/reflector-shared')
const container = require('../container')
const {getAccount} = require('../../utils')
const nonceManager = require('../../ws-server/nonce-manager')
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
        const updateTimeReached = pendingConfig?.timestamp < timestamp
        if (!(updateTimeReached || pendingConfig?.allowEarlySubmission))
            return false

        if (!updateTimeReached) { //if update time is not reached, check if all signatures are present
            if (!areAllSignaturesPresent(
                [...config.nodes.keys()],
                [...pendingConfig.config.nodes.keys()],
                pendingConfig.signatures
            ))
                return false
        }

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

        const syncTimestamp = (isPendingConfigExpired(pendingConfig) || pendingConfig.allowEarlySubmission)
            ? timestamp
            : pendingConfig.timestamp

        await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseUpdateFee, syncTimestamp)

        if (hasMoreTxns) //if true, the config has more transactions to be submitted
            return true

        await settingsManager.applyPendingUpdate(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG))
        return true
    }

    __getNextTimestamp(currentTimestamp) {
        const {pendingConfig} = container.settingsManager
        if (!pendingConfig || this.__pendingTransaction || pendingConfig.allowEarlySubmission || isPendingConfigExpired(pendingConfig))
            return normalizeTimestamp(currentTimestamp + idleWorkerTimeframe, idleWorkerTimeframe)
        return pendingConfig.timestamp
    }

    get __timeframe() {
        return idleWorkerTimeframe
    }
}

module.exports = ClusterRunner