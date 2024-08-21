const {getSubscriptions, Asset, AssetType} = require('@reflector/reflector-shared')
const {scValToNative} = require('@stellar/stellar-sdk')
const {getSubscriptionsContractState} = require('@reflector/reflector-shared/helpers/entries-helper')
const {getLastContractEvents} = require('../../utils/rpc-helper')
const {decrypt} = require('../../utils/crypto-helper')
const logger = require('../../logger')
const container = require('../container')
const PendingSyncDataCache = require('./pending-notifications-cache')
const SubscriptionsSyncData = require('./subscriptions-sync-data')

/**
 * @typedef {import('@reflector/reflector-shared').OracleConfig} OracleConfig
 */

/**
 * @typedef {Object} PriceData
 * @property {OracleConfig} contract - contract
 * @property {BigInt[]} prices - prices
 */

/**
 * @typedef {Object} Subscription
 * @property {BigInt} id - subscription id
 * @property {BigInt} balance - balance
 * @property {number} threshold - threshold
 * @property {BigInt} lastPrice - last price
 * @property {number} lastNotification - last notification
 * @property {number} lastCharge - last charge
 * @property {{source: string, asset: Asset}} base - base asset
 * @property {{source: string, asset: Asset}} quote - quote asset
 * @property {number} heartbeat - heartbeat
 * @property {number} status - status
 * @property {BigInt} owner - owner
 * @property {{url: string}[]} webhook - webhook
 */

function getNormalizedAsset(raw) {
    const tickerAsset = {
        source: raw.source,
        asset: new Asset(
            AssetType.getType(raw.asset[0]),
            raw.asset[1]
        )
    }
    return tickerAsset
}

async function getWebhook(id, webhookBuffer) {
    const verifiedWebhook = []
    if (!webhookBuffer || !webhookBuffer.length)
        return verifiedWebhook
    try {
        //decrypt webhook
        const decrypted = await decrypt(container.settingsManager.appConfig.rsaKeyObject, new Uint8Array(webhookBuffer))
        if (!decrypted)
            return null
        const rawWebhook = Buffer.from(decrypted).toString()
        if (!rawWebhook || !rawWebhook.length)
            return null
        const webhook = rawWebhook.startsWith('[') ? JSON.parse(rawWebhook) : rawWebhook.split(',').map(url => ({url}))
        if (webhook && !Array.isArray(webhook))
            throw new Error('Invalid webhook data')
        for (const webhookItem of webhook) {
            if (webhookItem.url)
                verifiedWebhook.push(webhookItem)
        }
    } catch (e) {
        logger.error(`Error decrypting webhook: ${e.message}. Subscription ${id?.toString()}`)
    }
    return verifiedWebhook
}

/**
 * @param {string} contractId - contract id
 * @param {string} [cursor] - cursor
 * @returns {Promise<{events: any[], pagingToken: string}>}
 * */
async function loadLastEvents(contractId, cursor = null) {
    const {settingsManager} = container
    const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
    const {events: rawEvents, pagingToken} = await getLastContractEvents(contractId, 60 * 60, cursor, sorobanRpc)
    const events = rawEvents
        .map(raw => {
            const data = {
                topic: raw.topic.map(t => scValToNative(t)),
                value: scValToNative(raw.value),
                timestamp: raw.timestamp
            }
            return data
        })
    return {events, pagingToken}
}

class SubscriptionContractManager {

    constructor(contractId) {
        if (!contractId)
            throw new Error('Contract id is required')
        this.contractId = contractId
    }

    /**
     * @type {string} - contract id
     */
    contractId = null

    /**
     * @type {boolean}
     */
    isInitialized = false

    async init() {
        if (this.isInitialized)
            return
        await this.__loadSubscriptionsData()
        this.isInitialized = true
    }

    /**
     * @type {Map<BigInt, Subscription>}>}
     */
    __subscriptions = new Map()

    /**
     * @type {SubscriptionSyncData}
     */
    __lastSyncData = null

    /**
     * @type {PendingSyncDataCache}
     */
    __pendingSyncData = new PendingSyncDataCache()

    /**
     * @type {string}
     */
    __pagingToken = null

    async __loadSubscriptionsData() {
        const {settingsManager} = container
        const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
        const {lastSubscriptionId} = await getSubscriptionsContractState(this.contractId, sorobanRpc)
        const rawData = await getSubscriptions(this.contractId, sorobanRpc, lastSubscriptionId)
        for (const raw of rawData)
            try {
                if (raw && raw.status === 0) //only active subscriptions
                    await this.__setSubscription(raw)
            } catch (err) {
                logger.error({err}, `Error on adding subscription ${raw.id?.toString()}`)
            }
    }

    /**
     * @param {any} raw - raw subscription data
     */
    async __setSubscription(raw) {
        const currentSubscription = this.__subscriptions.get(raw.id)
        const base = getNormalizedAsset(raw.base)
        const quote = getNormalizedAsset(raw.quote)
        const webhook = await getWebhook(raw.id, raw.webhook)
        const subscription = {
            base,
            quote,
            balance: raw.balance,
            status: raw.status,
            id: raw.id,
            lastCharge: Number(raw.updated),
            owner: raw.owner,
            threshold: raw.threshold,
            webhook,
            lastNotification: currentSubscription?.lastNotification || 0,
            lastPrice: currentSubscription?.lastPrice || 0n,
            heartbeat: raw.heartbeat
        }
        this.__subscriptions.set(subscription.id, subscription)
    }

    async processLastEvents() {
        logger.debug(`Processing events for contract ${this.contractId} from ${this.__pagingToken}`)
        const {events, pagingToken} = await loadLastEvents(this.contractId, this.__pagingToken)
        logger.debug(`Loaded ${events.length} events for contract ${this.contractId}, new paging token: ${pagingToken}`)
        this.__pagingToken = pagingToken

        const triggerEvents = events
        for (const event of triggerEvents) {
            try {
                const eventTopic = event.topic[1]
                switch (eventTopic) {
                    case 'created':
                    case 'deposited':
                        {
                            const [id, rawSubscription] = event.value
                            logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                            rawSubscription.id = id
                            await this.__setSubscription(rawSubscription)
                        }
                        break
                    case 'suspended':
                    case 'cancelled':
                        {
                            const id = event.value[1]
                            logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                            if (this.__subscriptions.has(id))
                                this.__subscriptions.delete(id)
                        }
                        break
                    case 'charged':
                        {
                            const timestamp = event.value[0]
                            const id = event.value[1]
                            logger.debug(`Subscription ${id} charged. Contract ${this.contractId}`)
                            if (this.__subscriptions.has(id)) {
                                const subscription = this.__subscriptions.get(id)
                                subscription.lastCharge = Number(timestamp)
                            }
                        }
                        break
                    case 'triggered': //do nothing
                        break
                    default:
                        logger.error(`Unknown event type: ${eventTopic}`)
                }
            } catch (e) {
                logger.error(`Error processing event ${event.topic}: ${e.message}`)
            }
        }
    }

    async trySetRawSyncData(rawSyncData) {
        const {data, signatures} = rawSyncData
        const newSyncData = new SubscriptionsSyncData(data)
        await newSyncData.calculateHash()
        newSyncData.tryAddSignature(signatures)
        this.trySetSyncData(newSyncData)
    }

    /**
     * @param {SubscriptionsSyncData} newSyncData - sync data
     */
    trySetSyncData(newSyncData) {
        const newSyncItem = this.__pendingSyncData.push(newSyncData)
        const lastTimestamp = this.__lastSyncData?.timestamp || 0
        if (newSyncItem.isVerified && newSyncItem.timestamp >= lastTimestamp)
            this.__lastSyncData = newSyncData
    }

    get lastSyncData() {
        return this.__lastSyncData
    }

    /**
     * @returns {Subscription[]} ordered subscriptions array
     */
    get subscriptions() {
        return [...this.__subscriptions.values()].sort((a, b) => {
            if (a.id < b.id) return -1
            else if (a.id > b.id) return 1
            return 0
        })
    }
}

/**
 * @type {Map<string, SubscriptionContractManager>}
 */
const subscriptionManager = new Map()

function getManager(contractId) {
    return subscriptionManager.get(contractId)
}

function removeManager(contractId) {
    subscriptionManager.delete(contractId)
}

function addManager(contractId) {
    const manager = new SubscriptionContractManager(contractId)
    subscriptionManager.set(contractId, manager)
    return manager
}

/**
 * @returns {Subscription[]} ordered subscriptions array from all contracts
 */
function getAllSubscriptions() {
    const allSubscriptions = [...subscriptionManager.values()]
        .sort((a, b) => a.contractId.localeCompare(b.contractId))
        .map(x => x.subscriptions)
        .flat()
    return allSubscriptions
}

module.exports = {
    addManager,
    getManager,
    removeManager,
    getAllSubscriptions,
    SubscriptionContractManager
}