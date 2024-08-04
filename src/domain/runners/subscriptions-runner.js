const {
    buildSubscriptionTriggerTransaction,
    buildSubscriptionsInitTransaction,
    getContractState,
    buildSubscriptionChargeTransaction,
    sortObjectKeys,
    normalizeTimestamp
} = require('@reflector/reflector-shared')
const container = require('../container')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const {getManager, removeManager} = require('../subscriptions-data-provider')
const {makeRequest} = require('../../utils/requests-helper')
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

        logger.trace(`SubscriptionsRunner -> __workerFn -> sourceAccount: ${sourceAccount.accountId()}: ${sourceAccount.sequenceNumber()}`)

        const contractState = await getContractState(this.contractId, sorobanRpc)

        logger.trace(`Contract state: lastSubscriptionsId: ${Number(contractState.lastSubscriptionsId)}, initialized: ${contractState.isInitialized}, contractId: ${this.contractId}}`)
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
            if (!subscriptionsContractManager.isRunning)
                await subscriptionsContractManager.start()

            const {
                events,
                charges,
                eventHexHashes,
                root,
                rootHex
            } = await subscriptionsContractManager.getSubscriptionActions(timestamp)

            let chargeTimestamp = timestamp

            if (events.length > 0) {
                for (let i = 0; i < events.length; i++) {
                    const event = events[i]
                    this.__processTriggerData(event, eventHexHashes, rootHex)
                }

                updateTxBuilder = async (account, fee, maxTime) => await buildSubscriptionTriggerTransaction({
                    account,
                    network,
                    sorobanRpc,
                    admin,
                    triggerHash: root,
                    timestamp,
                    contractId: this.contractId,
                    fee,
                    maxTime
                })

                const txResponse = await this.__buildAndSubmitTransaction(
                    updateTxBuilder,
                    sourceAccount,
                    baseFee,
                    timestamp,
                    this.__dbSyncDelay
                )

                chargeTimestamp = normalizeTimestamp(txResponse.createdAt * 1000 + 5000 - 1, 5000) //round to 5 seconds

                //increment sequence number for changes
                sourceAccount.incrementSequenceNumber()

                //set notification timestamp for processed events
                subscriptionsContractManager.setNotificationTimestamp(timestamp, events.map(e => e.id))
            }

            if (charges.length > 0) {
                updateTxBuilder = async (account, fee, maxTime) => await buildSubscriptionChargeTransaction({
                    account,
                    network,
                    sorobanRpc,
                    admin,
                    ids: charges.slice(0, Math.min(15, charges.length)),
                    timestamp,
                    contractId: this.contractId,
                    fee,
                    maxTime
                })

                await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseFee, chargeTimestamp, 0)
            }
        }
    }

    /**
     * @param {any} event - trigger item data
     * @param {string[]} events - trigger event hashes
     * @param {string} root - composed trigger events hash
     */
    __processTriggerData(event, events, root) {
        try {
            const {webhook} = event
            if (webhook && webhook.length > 0) {
                const update = {
                    contract: this.contractId,
                    events,
                    event: event.update,
                    root
                }
                const signature = container.settingsManager.appConfig.keypair.sign(JSON.stringify(sortObjectKeys(update))).toString('base64')
                const envelope = {
                    update,
                    signature,
                    verifier: container.settingsManager.appConfig.publicKey
                }
                for (let j = 0; j < Math.min(events.length, 3); j++) {
                    const currentWebhook = webhook[j]?.url
                    if (currentWebhook)
                        makeRequest(currentWebhook, {method: 'POST', data: envelope, timeout: 5000})
                            .catch(e => {
                                logger.debug(`Failed to send webhook to ${currentWebhook}: ${e.message}`)
                            })
                }
            }
        } catch (e) {
            logger.error(`Failed to process trigger ${event.id}: ${e.message}`)
        }
    }

    get __timeframe() {
        return 60000
    }

    __getNextTimestamp(currentTimestamp) {
        let nextTimestamp = currentTimestamp + this.__timeframe
        while (nextTimestamp < Date.now()) {
            nextTimestamp += this.__timeframe
        }
        return nextTimestamp
    }

    get __dbSyncDelay() {
        return (container.settingsManager.appConfig.dbSyncDelay || 15) * 1000
    }

    stop() {
        super.stop()
        removeManager(this.contractId)
    }
}

module.exports = SubscriptionsRunner