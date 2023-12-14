const {buildUpdateTransaction} = require('@reflector/reflector-shared')
const {retrieveAccountProps} = require('@reflector/reflector-db-connector')
const logger = require('../../logger')
const container = require('../container')
const NodeStatus = require('../node-status')
const RunnerBase = require('./runner-base')

/**
 * @typedef {import('../../models/blockchain/transactions/pending-transaction-base')} PendingTransactionBase
 */

const idleWorkerTimeframe = 1000 * 60 //1 minute

class ClusteUpdatesRunner extends RunnerBase {

    async __workerFn() {
        const {settingsManager} = container
        const {pendingConfig, config} = settingsManager
        if (!pendingConfig) {
            logger.debug('No pending config')
            return idleWorkerTimeframe
        }

        if (settingsManager.nodeStatus !== NodeStatus.ready) {
            logger.debug('Node is not ready')
            return idleWorkerTimeframe
        }

        if (pendingConfig.timestamp > Date.now())
            return pendingConfig.timestamp - Date.now()


        const {horizonUrl, dbConnector, network} = this.__getBlockchainConnectorSettings()
        const accountInfo = await retrieveAccountProps(dbConnector, config.systemAccount)
        const account = this.__getAccount(config.systemAccount, accountInfo.sequence)

        const tx = await buildUpdateTransaction({
            account,
            network,
            horizonUrl,
            newConfig: pendingConfig,
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

    get __timeframe() {
        const {pendingConfig} = container.settingsManager
        if (!pendingConfig)
            return idleWorkerTimeframe
        return pendingConfig.timestamp - Date.now()
    }
}

module.exports = ClusteUpdatesRunner