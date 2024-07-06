const {buildSubscriptionTriggerTransaction, buildSubscriptionsInitTransaction, getContractState, buildSubscriptionChargeTransaction} = require('@reflector/reflector-shared')
const container = require('../container')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const {getManager, removeManager} = require('../subscriptions-data-provider')
const statisticsManager = require('../statistics-manager')
const RunnerBase = require('./runner-base')

class SubscriptionsRunner extends RunnerBase {
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

        const {admin, fee: baseFee} = contractConfig

        //cluster network data
        const {networkPassphrase: network, sorobanRpc} = settingsManager.getBlockchainConnectorSettings()

        //get account info
        const sourceAccount = await getAccount(admin, sorobanRpc)

        logger.trace(`OracleRunner -> __workerFn -> sourceAccount: ${sourceAccount.accountId()}: ${sourceAccount.sequenceNumber()}`)

        const contractState = await getContractState(this.contractId, sorobanRpc)

        logger.trace(`Contract state: lastTimestamp: ${Number(contractState.lastSubscriptionsId)}, initialized: ${contractState.isInitialized}, contractId: ${this.contractId}}`)
        statisticsManager.setLastSubscriptionData(
            this.contractId,
            Number(contractState.lastSubscriptionsId),
            contractState.isInitialized
        )

        let updateTxBuilder = null
        if (!contractState.isInitialized) {
            updateTxBuilder = async (account, fee, maxTime) => await buildSubscriptionsInitTransaction({
                account,
                network,
                sorobanRpc,
                config: contractConfig,
                fee,
                maxTime
            })
            await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseFee, timestamp, this.__dbSyncDelay)
        } else {

            const subscriptionsContractManager = getManager(this.contractId)
            if (!subscriptionsContractManager.isInitialized)
                await subscriptionsContractManager.init()

            const {triggers, charges, heartbeats} = await subscriptionsContractManager.getSubscriptionActions(timestamp)

            if (triggers.length > 0 || heartbeats.length > 0) {
                updateTxBuilder = async (account, fee, maxTime) => await buildSubscriptionTriggerTransaction({
                    account,
                    network,
                    sorobanRpc,
                    admin,
                    triggerIds: (triggers || []).map(t => t.id),
                    heartbeatIds: heartbeats || [],
                    timestamp,
                    contractId: this.contractId,
                    fee,
                    maxTime
                })

                await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseFee, timestamp, this.__dbSyncDelay)

                for (const trigger of triggers) {
                    const {webhook, id, diff, price, lastPrice} = trigger
                    logger.trace(`Trigger ${id} webhook: ${webhook}, timestamp: ${timestamp}, contractId: ${this.contractId}, diff: ${diff}, price: ${price}, lastPrice: ${lastPrice}`)
                }

                sourceAccount.incrementSequenceNumber()
            }

            if (charges.length > 0) {
                updateTxBuilder = async (account, fee, maxTime) => await buildSubscriptionChargeTransaction({
                    account,
                    network,
                    sorobanRpc,
                    admin,
                    ids: charges,
                    timestamp,
                    contractId: this.contractId,
                    fee,
                    maxTime
                })

                await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseFee, timestamp, this.__dbSyncDelay)
            }
        }
    }

    get __timeframe() {
        return 60000
    }

    __getNextTimestamp(currentTimestamp) {
        return currentTimestamp + this.__timeframe
    }

    get __dbSyncDelay() {
        return (container.settingsManager.appConfig.dbSyncDelay || 15) * 1000
    }
}

module.exports = SubscriptionsRunner