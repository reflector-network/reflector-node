const {getSubscriptions, Asset, AssetType, normalizeTimestamp} = require('@reflector/reflector-shared')
const {scValToNative} = require('@stellar/stellar-sdk')
const {getSubscriptionById, getSubscriptionsContractState} = require('@reflector/reflector-shared/helpers/entries-helper')
const {getLastContractEvents} = require('../utils/rpc-helper')
const logger = require('../logger')
const container = require('./container')
const priceManager = require('./price-manager')

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
     * @returns {Promise<{triggers: any[], heartbeats: any[], charges: any[]}>}
     */
    async getSubscriptionActions(timestamp) {
        await this.__processLastEvents()
        const triggers = []
        const heartbeats = []
        const charges = []
        for (const subscription of this.__subscriptions.values()) {
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
                    charges.push(subscription.id)

                if (!isValidSources(this.contractId, asset1, asset2)) {
                    logger.debug(`Datasource ${asset1.source} or/and ${asset2.source} not supported. Subscription ${id}.`)
                    continue
                }
                const price = await priceManager.getPriceForPair(asset1, asset2, timestamp)
                const diff = getDiff(lastPrice, price)
                if (diff >= threshold) {
                    triggers.push({id, diff, price, lastPrice, timestamp, webhook})
                    //set last price and current timestamp
                    subscription.lastNotification = timestamp
                } else if (timestamp - lastNotification >= heartbeat * 60 * 1000) {
                    heartbeats.push(subscription.id)
                    //set last price and current timestamp
                    subscription.lastNotification = timestamp
                }
                subscription.lastPrice = price

            } catch (err) {
                logger.error({err}, `Error processing subscription ${subscription.id}`)
            }
        }

        return {triggers, heartbeats, charges}
    }

    async __loadSubscriptionsData() {
        const {settingsManager} = container
        const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
        const {lastSubscriptionId} = await getSubscriptionsContractState(this.contractId, sorobanRpc)
        const rawData = await getSubscriptions(this.contractId, sorobanRpc, lastSubscriptionId)
        for (const raw of rawData)
            this.__addSubscription(raw)
    }

    __addSubscription(raw, force = false) {
        if (this.__subscriptions.has(raw.id) && !force)
            return
        const asset1 = getNormalizedAsset(raw.asset1)
        const asset2 = getNormalizedAsset(raw.asset2)
        const subscription = {
            asset1,
            asset2,
            balance: raw.balance,
            isActive: raw.is_active,
            id: raw.id,
            lastCharge: Number(raw.last_charge),
            owner: raw.owner,
            threshold: raw.threshold,
            webhook: raw.webhook,
            lastNotification: 0,
            lastPrice: 0n,
            heartbeat: raw.heartbeat
        }
        this.__subscriptions.set(subscription.id, subscription)
    }

    async __processLastEvents() {
        const {events, pagingToken} = await loadLastEvents(this.contractId, this.__pagingToken)
        this.__pagingToken = pagingToken

        const {settingsManager} = container
        const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()

        const normalizedTimestamp = normalizeTimestamp(Date.now(), 60 * 1000)
        const triggerEvents = events
        for (const event of triggerEvents) {
            try {
                const eventTopic = event.topic[1]
                switch (eventTopic) {
                    case 'created':
                    case 'deposit':
                        {
                            const subscriptionId = event.value
                            if (this.__subscriptions.has(subscriptionId))
                                continue
                            const rawSubscription = await getSubscriptionById(this.contractId, sorobanRpc, subscriptionId)
                            this.__addSubscription(rawSubscription)
                        }
                        break
                    case 'suspended':
                        {
                            for (const id in event.value) {
                                if (this.__subscriptions.has(id)) {
                                    this.__subscriptions.delete(id)
                                }
                            }
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
                    case 'triggered':
                    case 'heartbeat':
                        {
                            const timestamp = event.value[0]
                            const ids = event.value[1]
                            for (const id of ids) {
                                if (!this.__subscriptions.has(id)) {
                                    logger.warn(`Subscription ${id} for last trigger not found`)
                                }
                                const subscription = this.__subscriptions.get(id)
                                if (subscription.lastNotification < timestamp) {
                                    subscription.lastNotification = Number(timestamp)
                                    subscription.lastPrice = 0n
                                }
                            }
                        }
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