const {getSubscriptions, Asset, AssetType, getSubscriptionsContractState} = require('@reflector/reflector-shared')
const {scValToNative} = require('@stellar/stellar-sdk')
const {getLastContractEvents, getEventsLedgerInfo} = require('../../utils/rpc-helper')
const {decrypt} = require('../../utils/crypto-helper')
const logger = require('../../logger')
const container = require('../container')
const dataSourceManager = require('../data-sources-manager')
const PendingSyncDataCache = require('./pending-notifications-cache')
const SubscriptionsSyncData = require('./subscriptions-sync-data')

const validSymbols = require('./valid-symbols.json')

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
 * @property {number} lastCharge - last charge
 * @property {{source: string, asset: Asset}} base - base asset
 * @property {{source: string, asset: Asset}} quote - quote asset
 * @property {number} heartbeat - heartbeat
 * @property {number} status - status
 * @property {BigInt} owner - owner
 * @property {{url: string}[]} webhook - webhook
 */

function getNormalizedAsset(raw) {
    if (raw.asset.constructor.name !== 'String')
        throw new Error('Invalid asset data')
    const assetType = dataSourceManager.isStellarSource(raw.source)
        ? AssetType.STELLAR
        : AssetType.OTHER
    const asset = new Asset(
        assetType,
        raw.asset
    )
    const tickerAsset = {
        source: raw.source,
        asset
    }
    return tickerAsset
}

async function getWebhook(id, webhookBuffer) {
    const {clusterSecretObject} = container.settingsManager
    const verifiedWebhook = []
    if (!(webhookBuffer && webhookBuffer.length && clusterSecretObject))
        return verifiedWebhook
    try {
        //decrypt webhook
        const decrypted = await decrypt(clusterSecretObject, new Uint8Array(webhookBuffer))
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
 * @param {number} lastProcessedLedger - last processed ledger
 * @param {string[]} sorobanRpc - soroban rpc
 * @returns {Promise<{events: any[], lastLedger: string}>}
 * */
async function loadLastEvents(contractId, lastProcessedLedger, sorobanRpc) {
    const {events: rawEvents, lastLedger} = await getLastContractEvents(contractId, lastProcessedLedger, sorobanRpc)
    const events = rawEvents
        .map(raw => {
            const data = {
                topic: raw.topic.map(t => scValToNative(t)),
                value: scValToNative(raw.value),
                timestamp: raw.timestamp
            }
            return data
        })
    return {events, lastLedger}
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
    __isInitialized = false

    /**
     * @type {Map<BigInt, Subscription>}>}
     */
    __subscriptions = new Map()

    /**
     * @type {SubscriptionsSyncData}
     */
    __lastSyncData = null

    /**
     * @type {PendingSyncDataCache}
     */
    __pendingSyncData = new PendingSyncDataCache()

    /**
     * @type {number}
     */
    __lastLedger = null

    /**
     * Load subscriptions data from the contract
     * @param {string[]} sorobanRpc - soroban rpc
     * @return {Promise<void>}
     */
    async __loadSubscriptionsData(sorobanRpc) {
        const {lastSubscriptionId} = await getSubscriptionsContractState(this.contractId, sorobanRpc)
        const rawData = await getSubscriptions(this.contractId, sorobanRpc, lastSubscriptionId)
        for (const raw of rawData)
            await this.__setSubscription(raw)
        logger.trace(`Loaded ${this.__subscriptions.size} subscriptions for contract ${this.contractId}`)
        this.__isInitialized = true
    }

    /**
     * @param {any} raw - raw subscription data
     */
    async __setSubscription(raw) {
        try {
            if (!(raw && raw.status === 0)) {//only active subscriptions, raw can be null if the subscription was deleted
                return
            }
            const base = getNormalizedAsset(raw.base)
            const quote = getNormalizedAsset(raw.quote)
            if (base.asset.isContractId || quote.asset.isContractId) {
                logger.warn(`Contract id is not supported as subscription ticker asset. Subscription ${raw.id}. Contract ${this.contractId}`)
                return
            }

            if (base.source === 'exchange' && !validSymbols.includes(base.asset.code) || quote.source === 'exchange' && !validSymbols.includes(quote.asset.code)) {
                logger.warn(`Invalid symbol in subscription ${raw.id}. Contract ${this.contractId}`)
                return
            }

            if (!(dataSourceManager.has(base.source) && dataSourceManager.has(quote.source))) {//the source is not supported
                logger.debug(`Subscription ${raw.id} source(s) not supported. Contract ${this.contractId}`)
                return
            }

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
                heartbeat: raw.heartbeat
            }
            this.__subscriptions.set(subscription.id, subscription)
        } catch (err) {
            logger.error({err, rawSubscription: raw, msg: `Error on adding subscription ${raw?.id.toString()}, contract ${this.contractId}`})
        }
    }

    async __processLastEvents() {
        //get rpc
        const {settingsManager} = container
        const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()

        //get events ledger info
        const {oldestLedger, latestLedger} = await getEventsLedgerInfo(sorobanRpc, this.contractId)
        //check if out of range
        const isOutOfRange = oldestLedger > this.__lastLedger
        //determine start ledger
        const startLedger = isOutOfRange ? latestLedger - 360 : this.__lastLedger //if out of range, load last 360 ledgers
        logger.debug(`Oldest ledger with events: ${oldestLedger}, last processed ledger: ${this.__lastLedger}, latest ledger: ${latestLedger}, isOutOfRange: ${isOutOfRange}`)

        //get start ledger for events
        if (isOutOfRange) {
            logger.debug(`Initializing subscriptions data for contract ${this.contractId}. Last processed ledger: ${this.__lastLedger}, start ledger: ${startLedger}, isInitialized: ${this.__isInitialized}`)
            this.__subscriptions.clear()
            await this.__loadSubscriptionsData(sorobanRpc)
            logger.debug(`Subscriptions data initialized for contract ${this.contractId}. Loaded ${this.__subscriptions.size} active subscriptions.`)
        }

        logger.debug(`Processing events for contract ${this.contractId} from ${startLedger}`)
        const {events, lastLedger} = await loadLastEvents(this.contractId, startLedger, sorobanRpc)
        logger.debug(`Loaded ${events.length} events for contract ${this.contractId}, new last ledger: ${lastLedger}`)
        this.__lastLedger = lastLedger

        const triggerEvents = events
        for (const event of triggerEvents) {
            try {
                const eventTopic = event.topic[1] === 'triggers' //triggers topic appears in new version of the contract
                    ? event.topic[2]
                    : event.topic[1]
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
                            const id = event.value[0] || event.value
                            logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                            if (this.__subscriptions.has(id))
                                this.__subscriptions.delete(id)
                        }
                        break
                    case 'charged':
                        {
                            const id = event.value[0]
                            const timestamp = event.value[2]
                            logger.debug(`Subscription ${id} charged. Contract ${this.contractId}`)
                            if (this.__subscriptions.has(id)) {
                                const subscription = this.__subscriptions.get(id)
                                subscription.lastCharge = Number(timestamp)
                            }
                        }
                        break
                    case 'triggered': //do nothing
                    case 'updated':
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
        const syncItem = this.__pendingSyncData.push(newSyncData)
        const lastTimestamp = this.__lastSyncData?.timestamp || 0
        if (syncItem.isVerified && syncItem.timestamp >= lastTimestamp) {
            this.__lastSyncData = syncItem
            logger.debug(`New sync data set for contract ${this.contractId}, timestamp: ${syncItem.timestamp}, hash: ${syncItem.hashBase64}, signatures: ${syncItem.__signatures.map(s => s.pubkey).join(',')}`)
        }
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