const {getSubscriptions, Asset, AssetType, normalizeTimestamp, sortObjectKeys} = require('@reflector/reflector-shared')
const {scValToNative} = require('@stellar/stellar-sdk')
const {getSubscriptionsContractState} = require('@reflector/reflector-shared/helpers/entries-helper')
const {getLastContractEvents} = require('../utils/rpc-helper')
const {sha256, decrypt} = require('../utils/crypto-helper')
const logger = require('../logger')
const container = require('./container')
const priceManager = require('./price-manager')

class TriggerEvent {
    constructor(id, diff, price, lastPrice, timestamp, webhook) {
        this.id = id
        this.webhook = webhook
        this.update = {
            id: this.id.toString(),
            diff,
            price: price.toString(),
            lastPrice: lastPrice.toString(),
            timestamp
        }
    }

    async computeHash() {
        this.hash = Buffer.from(await sha256(Buffer.from(JSON.stringify(sortObjectKeys(this.update)))))
    }
}

class EventsContainer {

    constructor(timestamp) {
        this.timestamp = timestamp
        this.events = []
        this.charges = []
    }

    async addEvent(id, diff, price, lastPrice, timestamp, webhook) {
        const event = new TriggerEvent(id, diff, price, lastPrice, timestamp, webhook)
        await event.computeHash()
        this.events.push(event)
    }

    addCharge(id) {
        this.charges.push(id)
    }

    async finish() {
        this.events.sort((a, b) => a.id < b.id ? -1 : 1)
        this.eventHashes = this.events.map(t => t.hash)
        this.eventHexHashes = this.eventHashes.map(h => h.toString('hex'))
        this.root = Buffer.from(await sha256(Buffer.concat(this.eventHashes)))
        this.rootHex = this.root.toString('hex')
    }
}

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
        const webhook = decrypted ? JSON.parse(Buffer.from(decrypted)) : null
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

function isValidSources(contractId, asset1, asset2) {
    const {settingsManager} = container
    const contract = container.settingsManager.getContractConfig(contractId)
    const {dataSources} = contract
    return (dataSources === '*' || dataSources.indexOf(asset1.source) >= 0 && dataSources.indexOf(asset2.source) >= 0) //check if sources are allowed
        && settingsManager.hasContractConfig(asset1.source) && settingsManager.hasContractConfig(asset2.source) //check if sources are present in config
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

/**
 * @param {BigInt} price1 - price 1
 * @param {BigInt} price2 - price 2
 * @returns {number} - diff in integer percents
 */
function getDiff(price1, price2) {
    if (price1 === 0n || price2 === 0n)
        return 0

    const absDiff = price1 > price2 ? price1 - price2 : price2 - price1
    const minValue = price1 < price2 ? price1 : price2
    const percentageDiff = (absDiff * 1000n) / minValue

    return Number(percentageDiff)
}

class SubscriptionContractManager {

    constructor(contractId) {
        this.contractId = contractId
    }

    isInitialized = false

    /**
     * @type {Map<BigInt, any>}>}
     */
    __subscriptions = new Map()

    /**
     * @type {string}
     */
    __pagingToken = null

    async init() {
        await this.__loadSubscriptionsData()
        this.isInitialized = true
    }

    /**
     * @param {number} timestamp - timestamp
     * @returns {Promise<EventsContainer>}
     */
    async getSubscriptionActions(timestamp) {
        await this.__processLastEvents()
        const container = new EventsContainer(timestamp)
        for (const subscription of this.__subscriptions.values()) {
            if (subscription.status !== 0) //only active subscriptions
                continue
            try {
                const {
                    id,
                    heartbeat,
                    threshold,
                    lastPrice,
                    lastNotification,
                    lastCharge,
                    asset1,
                    asset2,
                    webhook
                } = subscription

                if (timestamp - lastCharge >= 1000 * 60 * 60 * 24)
                    container.addCharge(subscription.id)

                if (!isValidSources(this.contractId, asset1, asset2)) {
                    logger.debug(`Datasource ${asset1.source} or/and ${asset2.source} not supported. Subscription ${id}.`)
                    continue
                }
                const price = await priceManager.getPriceForPair(asset1, asset2, timestamp)
                const diff = getDiff(lastPrice, price)
                if (diff >= threshold || timestamp - lastNotification >= heartbeat * 60 * 1000) {
                    await container.addEvent(id, diff, price, lastPrice, timestamp, webhook)
                    //set last price and current timestamp
                    subscription.lastNotification = timestamp
                }
                subscription.lastPrice = price

            } catch (err) {
                logger.error({err}, `Error processing subscription ${subscription.id}`)
            }
        }
        await container.finish()
        return container
    }

    async __loadSubscriptionsData() {
        const {settingsManager} = container
        const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
        const {lastSubscriptionId} = await getSubscriptionsContractState(this.contractId, sorobanRpc)
        const rawData = await getSubscriptions(this.contractId, sorobanRpc, lastSubscriptionId)
        for (const raw of rawData)
            try {
                if (raw.status === 0) //only active subscriptions
                    await this.__addSubscription(raw)
            } catch (err) {
                logger.error({err}, `Error on adding subscription ${raw.id?.toString()}`)
            }
    }

    async __addSubscription(raw) {
        if (this.__subscriptions.has(raw.id))
            return
        const asset1 = getNormalizedAsset(raw.asset1)
        const asset2 = getNormalizedAsset(raw.asset2)
        const webhook = await getWebhook(raw.id, raw.webhook)
        const subscription = {
            asset1,
            asset2,
            balance: raw.balance,
            status: raw.status,
            id: raw.id,
            lastCharge: Number(raw.last_charge),
            owner: raw.owner,
            threshold: raw.threshold,
            webhook,
            lastNotification: 0,
            lastPrice: 0n,
            heartbeat: raw.heartbeat
        }
        this.__subscriptions.set(subscription.id, subscription)
    }

    async __processLastEvents() {
        const {events, pagingToken} = await loadLastEvents(this.contractId, this.__pagingToken)
        this.__pagingToken = pagingToken

        const normalizedTimestamp = normalizeTimestamp(Date.now(), 60 * 1000)
        const triggerEvents = events
        for (const event of triggerEvents) {
            try {
                const eventTopic = event.topic[1]
                switch (eventTopic) {
                    case 'created':
                    case 'deposit':
                        {
                            const [subscriptionId, rawSubscription] = event.value
                            rawSubscription.id = subscriptionId
                            await this.__addSubscription(rawSubscription)
                        }
                        break
                    case 'suspended':
                    case 'cancelled':
                        {
                            for (const id in event.value)
                                if (this.__subscriptions.has(id))
                                    this.__subscriptions.delete(id)
                        }
                        break
                    case 'charged':
                        {
                            const timestamp = event.value[0]
                            const ids = event.value[1]
                            for (const id of ids) {
                                if (this.__subscriptions.has(id)) {
                                    const subscription = this.__subscriptions.get(id)
                                    subscription.lastCharge = Number(timestamp)
                                }
                            }
                        }
                        break
                    case 'trigger': //do nothing
                        break
                    default:
                        logger.error(`Unknown event type: ${eventTopic}`)
                }
            } catch (e) {
                logger.error(`Error processing event ${event.topic}: ${e.message}`)
            }
        }

        const subscriptionPromises = []
        for (const subscription of this.__subscriptions.values()) {
            if (subscription.lastPrice === 0n) {
                const setPrice = async () => {
                    try {
                        const {asset1, asset2, lastNotification} = subscription
                        if (!isValidSources(this.contractId, asset1, asset2)) {
                            logger.debug(`Datasource ${asset1.source} or/and ${asset2.source} not supported. Subscription ${subscription.id}.`)
                            return
                        }
                        subscription.lastPrice = await priceManager.getPriceForPair(asset1, asset2, lastNotification || normalizedTimestamp)
                    } catch (e) {
                        logger.error(`Error getting price for subscription ${subscription.id}: ${e.message}`)
                    }
                }
                subscriptionPromises.push(setPrice())
            }
        }
        await Promise.all(subscriptionPromises)
    }
}

/**
 * @type {Map<string, SubscriptionContractManager>}
 */
const subscriptionManager = new Map()

function getManager(contractId) {
    let manager = subscriptionManager.get(contractId)
    if (!manager) {
        manager = new SubscriptionContractManager(contractId)
        subscriptionManager.set(contractId, manager)
    }
    return manager
}

function removeManager(contractId) {
    subscriptionManager.delete(contractId)
}

module.exports = {
    getManager,
    removeManager
}