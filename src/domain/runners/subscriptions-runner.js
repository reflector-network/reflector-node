const {
    buildSubscriptionTriggerTransaction,
    buildSubscriptionsInitTransaction,
    getContractState,
    buildSubscriptionChargeTransaction,
    sortObjectKeys,
    normalizeTimestamp
} = require('@reflector/reflector-shared')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const container = require('../container')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const {addManager, getManager, removeManager} = require('../subscriptions/subscriptions-data-manager')
const {makeRequest} = require('../../utils/requests-helper')
const statisticsManager = require('../statistics-manager')
const nodesManager = require('../nodes/nodes-manager')
const MessageTypes = require('../../ws-server/handlers/message-types')
const SubscriptionProcessor = require('../subscriptions/subscriptions-processor')
const RunnerBase = require('./runner-base')

/**
 * @typedef {import('../subscriptions/subscriptions-sync-data')} SubscriptionsSyncData
 */

/**
 * @param {string} contractId - contract id
 * @param {SubscriptionsSyncData} data - sync data
 */
async function broadcastSyncData(contractId, data) {
    const plainObject = data.toPlainObject()
    const message = {
        type: MessageTypes.SYNC,
        data: {
            type: ContractTypes.SUBSCRIPTIONS,
            contractId,
            ...plainObject
        }
    }
    await nodesManager.broadcast(message)
    logger.debug(`Signature broadcasted. Contract id: ${contractId}, hash: ${data.hashBase64}`)
}

class SubscriptionsRunner extends RunnerBase {
    constructor(contractId) {
        if (!contractId)
            throw new Error('contractId is required')
        super(contractId)
        this.__subscriptionsManager = addManager(contractId)
        this.__subscriptionsProcessor = new SubscriptionProcessor(contractId, this.__subscriptionsManager)
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

        //get contract state
        const contractState = await getContractState(this.contractId, sorobanRpc)

        //get contract manager
        const subscriptionsContractManager = getManager(this.contractId)
        //broadcast last processed data if available
        if (subscriptionsContractManager.lastSyncData)
            broadcastSyncData(this.contractId, subscriptionsContractManager.lastSyncData)

        logger.trace(`Contract state: lastSubscriptionsId: ${Number(contractState.lastSubscriptionsId)}, initialized: ${contractState.isInitialized}, contractId: ${this.contractId}}`)
        statisticsManager.setLastSubscriptionData(
            this.contractId,
            Number(contractState.lastSubscriptionsId),
            contractState.isInitialized,
            subscriptionsContractManager.lastSyncData?.hashBase64 || null
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

            if (!this.__subscriptionsManager.isInitialized)
                await this.__subscriptionsManager.init()

            const {
                events,
                charges,
                eventHexHashes,
                syncData,
                root,
                rootHex
            } = await this.__subscriptionsProcessor.getSubscriptionActions(timestamp)

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
                subscriptionsContractManager.trySetSyncData(syncData)

                //broadcast sync data
                broadcastSyncData(this.contractId, syncData)
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
        const notifications = []
        const {proxy} = container.settingsManager.appConfig
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
                //get 3 first webhooks
                const urls = webhook.slice(0, 3).map(w => w.url)
                notifications.push({urls, data: envelope})
            }
            if (proxy) {
                for (let i = 0; i < proxy.connectionString.length; i++) {
                    const currentProxy = proxy.connectionString[i]
                    makeRequest(`${currentProxy}/notifications`,
                        {
                            method: 'POST',
                            headers: {'x-proxy-validation': proxy.proxyValidationKey},
                            data: {notifications},
                            timeout: 5000
                        })
                        .catch(e => {
                            logger.debug(`Failed to send webhook data to ${currentProxy}: ${e.message}`)
                        })
                }
            } else {
                for (let i = 0; i < notifications.length; i++) {
                    const {urls, data} = notifications[i]
                    for (let j = 0; j < urls.length; j++) {
                        makeRequest(urls[j],
                            {
                                method: 'POST',
                                data,
                                timeout: 5000
                            })
                            .catch(e => {
                                logger.debug(`Failed to send webhook data to ${urls[j]}: ${e.message}`)
                            })
                    }
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