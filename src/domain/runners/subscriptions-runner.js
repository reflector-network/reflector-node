const {
    buildSubscriptionTriggerTransaction,
    buildSubscriptionsInitTransaction,
    getContractState,
    buildSubscriptionChargeTransaction,
    sortObjectKeys,
    normalizeTimestamp,
    ContractTypes
} = require('@reflector/reflector-shared')
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

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const temp = array[i]
        array[i] = array[j]
        array[j] = temp
    }
    return array
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
            await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseFee, timestamp, this.__delay)
            return true
        }

        if (!this.__subscriptionsManager.isInitialized)
            await this.__subscriptionsManager.init()

        const {
            events,
            charges,
            eventHexHashes,
            syncData,
            root,
            rootHex
        } = await this.__subscriptionsProcessor.getSubscriptionActions(timestamp - this.__timeframe) //get actions for the completed timeframe

        let chargeTimestamp = timestamp

        if (events.length > 0) {
            this.__processTriggerData(events, eventHexHashes, rootHex)

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
                this.__delay
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
        return true
    }


    /**
     * @param {any} event - trigger item data
     * @param {string[]} events - trigger event hashes
     * @param {string} root - composed trigger events hash
     * @returns {{urls: string[], data: any} | null} - webhook data
     */
    __processSingleTriggerDataItem(event, events, root) {
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
                //delete fields that can be restored by the gateway
                delete update.events
                delete update.root
                delete update.contract
                const envelope = {
                    update,
                    signature
                }
                //get 3 first webhooks
                const urls = webhook.slice(0, 3).map(w => w.url)
                return {urls, data: envelope}
            }
        } catch (err) {
            logger.error({err}, `Failed to process trigger event ${event.id}, ${this.contractId}`)
        }
        return null
    }

    /**
     * @param {any[]} events - array of trigger items
     * @param {string[]} events - trigger event hashes
     * @param {string} root - composed trigger events hash
     */
    __processTriggerData(eventItems, events, root) {
        const {settingsManager} = container
        const {urls, gatewayValidationKey} = settingsManager.gateways
        try {
            const notifications = []
            for (let i = 0; i < eventItems.length; i++) {
                const eventItem = eventItems[i]
                const webhookData = this.__processSingleTriggerDataItem(eventItem, events, root)
                if (webhookData)
                    notifications.push(webhookData)
            }
            if (urls && urls.length > 0)
                this.__postNotificationsViaGateway(urls, gatewayValidationKey, notifications, events, root)
            else
                this.__postNotifications(notifications, events, root)
            logger.debug(`Webhook data sent for contract ${this.contractId}. Notifications count: ${notifications.length}`)
        } catch (err) {
            logger.error({err}, `Failed to process trigger data ${this.contractId}`)
        }
    }

    async __postNotificationsViaGateway(gateways, gatewayValidationKey, notifications, events, root) {

        const verifier = container.settingsManager.appConfig.publicKey
        const contract = this.contractId

        const unusedGateways = shuffleArray([...gateways]) //clone the gateways array to avoid mutations, and shuffle it

        logger.debug(`Sending webhook data to gateways: ${unusedGateways.join(', ')} for contract ${this.contractId}. Notifications count: ${notifications.length}`)

        const successfulGateways = []
        while (successfulGateways.length < 2 && unusedGateways.length > 0) {
            const currentGateway = unusedGateways.shift() //get the first gateway from the shuffled array
            try {
                await makeRequest(`${currentGateway}/notifications`,
                    {
                        method: 'POST',
                        headers: {'x-gateway-validation': gatewayValidationKey},
                        data: {
                            notifications,
                            events,
                            root,
                            verifier,
                            contract
                        },
                        timeout: 5000
                    })
                successfulGateways.push(currentGateway)
            } catch (e) {
                logger.debug(`Failed to send webhook data to ${currentGateway}: ${e.message}`)
            }
        }
        if (successfulGateways.length === 0)
            logger.error(`Failed to send webhook data to gateways for contract ${this.contractId}. Notifications count: ${notifications.length}`)
        else
            logger.debug(`Webhook data sent to gateways: ${successfulGateways.join(', ')} for contract ${this.contractId}. Notifications count: ${notifications.length}`)
    }

    async __postNotifications(notifications, events, root) {
        logger.debug(`Sending webhook data to webhooks for contract ${this.contractId}. Notifications count: ${notifications.length}`)

        const verifier = container.settingsManager.appConfig.publicKey
        const contract = this.contractId
        for (let i = 0; i < notifications.length; i++) {
            const {urls, data} = notifications[i]
            data.update = {...data.update, events, root, contract}
            data.verifier = verifier
            for (let j = 0; j < urls.length; j++) {
                try {
                    await makeRequest(urls[j],
                        {
                            method: 'POST',
                            data,
                            timeout: 5000
                        })
                } catch (e) {
                    logger.debug(`Failed to send webhook data to ${urls[j]}: ${e.message}`)
                }
            }
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

    get __delay() {
        //try to load subscriptions eyrlier than price worker, to have time to process events
        const syncDelay = container.settingsManager.appConfig.dbSyncDelay - 2000
        if (syncDelay >= 0)
            return syncDelay
        return container.settingsManager.appConfig.dbSyncDelay
    }

    stop() {
        super.stop()
        removeManager(this.contractId)
    }

    get __contractType() {
        return ContractTypes.SUBSCRIPTIONS
    }
}

module.exports = SubscriptionsRunner