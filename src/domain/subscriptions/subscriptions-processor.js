const {sortObjectKeys} = require('@reflector/reflector-shared')
const {sha256} = require('../../utils/crypto-helper')
const logger = require('../../logger')
const container = require('../container')
const {getPricesForPair} = require('../prices/price-manager')
const SubscriptionsSyncData = require('./subscriptions-sync-data')

/**
 * @typedef {import('@reflector/reflector-shared').OracleConfig} OracleConfig
 * @typedef {import('./subscriptions-data-manager').SubscriptionContractManager} SubscriptionContractManager
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

class TriggerEvent {
    constructor(id, base, quote, decimals, price, prevPrice, timestamp, webhook) {
        this.id = id
        this.webhook = webhook
        this.update = {
            subscription: this.id.toString(),
            base: assetToEventData(base),
            quote: assetToEventData(quote),
            decimals,
            price: price.toString(),
            prevPrice: prevPrice.toString(),
            timestamp
        }
    }

    async computeHash() {
        this.hash = Buffer.from(await sha256(Buffer.from(JSON.stringify(sortObjectKeys(this.update)))))
    }
}

class EventsContainer {

    constructor(contractId, timestamp, syncData) {
        this.contractId = contractId
        this.timestamp = timestamp
        this.syncData = syncData
        this.events = []
        this.charges = []
    }

    async addEvent(id, base, quote, decimals, price, prevPrice, timestamp, webhook) {
        const event = new TriggerEvent(id, base, quote, decimals, price, prevPrice, timestamp, webhook)
        await event.computeHash()
        this.events.push(event)
    }

    addCharge(id) {
        this.charges.push(id)
    }

    async finish() {
        //sort events by id and compute hashes
        this.events.sort((a, b) => a.id < b.id ? -1 : 1)
        this.eventHashes = this.events.map(t => t.hash)
        this.eventHexHashes = this.eventHashes.map(h => h.toString('base64'))
        this.root = Buffer.from(await sha256(Buffer.concat(this.eventHashes)))
        this.rootHex = this.root.toString('base64')

        //sign and add sync data
        this.syncData = new SubscriptionsSyncData({syncData: this.syncData, timestamp: this.timestamp})
        await this.syncData.calculateHash()
        this.syncData.sign(container.settingsManager.appConfig.keypair)
    }
}


function assetToEventData(asset) {
    return {
        source: asset.source,
        asset: asset.asset.code
    }
}
/**
 * @param {BigInt} oldPrice - old price
 * @param {BigInt} newPrice - new price
 * @returns {number} - unsigned diff in integer percents
 */
function getDiff(oldPrice, newPrice) {
    if (oldPrice === 0n || newPrice === 0n)
        return 0

    const absDiff = oldPrice > newPrice ? oldPrice - newPrice : newPrice - oldPrice
    const percentageDiff = (absDiff * 1000n) / oldPrice

    return Number(percentageDiff)
}

const day = 24 * 60 * 60 * 1000

const minute = 60 * 1000

class SubscriptionProcessor {

    /**
     * @param {string} contractId - contract id
     * @param {SubscriptionContractManager} subscriptionManager - subscription manager
     */
    constructor(contractId, subscriptionManager) {
        if (!contractId)
            throw new Error('contractId is required')
        if (!subscriptionManager)
            throw new Error('subscriptionManager is required')
        this.contractId = contractId
        this.__subscriptionManager = subscriptionManager
    }

    /**
     * @param {number} timestamp - timestamp
     * @returns {Promise<EventsContainer>}
     */
    async getSubscriptionActions(timestamp) {

        //process last events
        await this.__subscriptionManager.processLastEvents()

        //get subscriptions
        const subscriptions = this.__subscriptionManager?.subscriptions || []

        //get last sync data copy
        const syncData = this.__subscriptionManager.lastSyncData?.getSyncDataCopy() || {}

        const eventsContainer = new EventsContainer(this.contractId, timestamp, syncData)
        for (const subscription of subscriptions) {
            if (subscription.status !== 0) //only active subscriptions
                continue
            try {
                const {
                    id,
                    base,
                    quote,
                    heartbeat,
                    threshold,
                    lastPrice,
                    lastCharge,
                    webhook
                } = subscription

                if (timestamp - lastCharge >= day)
                    eventsContainer.addCharge(subscription.id)

                //get price for the pair from the last minute
                const {price, decimals} = await getPricesForPair(base.source, base.asset, quote.source, quote.asset, timestamp - minute)
                const diff = getDiff(lastPrice, price)
                const lastNotification = eventsContainer.syncData[id]?.lastNotification || 0
                if (diff >= threshold || timestamp - lastNotification >= heartbeat * 60 * 1000) {
                    await eventsContainer.addEvent(
                        id,
                        base,
                        quote,
                        decimals,
                        price, //if last price is 0, then it's the initial heartbeat. Send 0 price to prevent false alarms
                        lastPrice > 0n ? lastPrice : price,
                        timestamp,
                        webhook
                    )
                    eventsContainer.syncData[id] = {lastNotification: timestamp}
                }
                //update last price
                subscription.lastPrice = price

            } catch (err) {
                logger.error({err}, `Error processing subscription ${subscription.id}`)
            }
        }

        //finish events container
        await eventsContainer.finish()
        return eventsContainer
    }
}

module.exports = SubscriptionProcessor