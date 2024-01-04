const {buildUpdateTransaction} = require('@reflector/reflector-shared')
const {retrieveAccountProps} = require('@reflector/reflector-db-connector')
const logger = require('../../logger')
const container = require('../container')
const RunnerBase = require('./runner-base')

const idleWorkerTimeframe = 1000 * 60 //1 minute

class ClusteUpdatesRunner extends RunnerBase {

    async __workerFn() {
        const {settingsManager} = container
        const {pendingConfig, config} = settingsManager
        if (!pendingConfig) {
            logger.debug('No pending config')
            return idleWorkerTimeframe
        }

        if (pendingConfig.timestamp > Date.now())
            return pendingConfig.timestamp - Date.now()

        const {horizonUrl, blockchainConnector, networkPassphrase} = this.__getBlockchainConnectorSettings()
        const accountInfo = await retrieveAccountProps(blockchainConnector, config.systemAccount)
        const account = this.__getAccount(config.systemAccount, accountInfo.sequence)

        const tx = await buildUpdateTransaction({
            timestamp: pendingConfig.timestamp,
            account,
            network: networkPassphrase,
            horizonUrl,
            newConfig: pendingConfig.config,
            currentConfig: config
        })

        if (tx) { //if transaction is built, set it as pending
            this.__setPendingTransaction(tx)
            await this.__trySubmitTransaction()
        } else {
            //if tx is null, it means that update is not required on the blockchain, but we need to apply it locally
            //for example, node url is changed, but it's not required to update it on the blockchain
            settingsManager.applyPendingUpdate()
        }
        return idleWorkerTimeframe
    }

    __getNextTimestamp() {
        const {pendingConfig} = container.settingsManager
        if (!pendingConfig || this.__pendingTransaction)
            return Date.now() + idleWorkerTimeframe
        return pendingConfig.timestamp
    }

    get __timeframe() {
        return 1
    }
}

module.exports = ClusteUpdatesRunner