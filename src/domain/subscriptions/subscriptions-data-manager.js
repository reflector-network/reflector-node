const {getSubscriptions, Asset, AssetType, sortObjectKeys} = require('@reflector/reflector-shared')
const {scValToNative} = require('@stellar/stellar-sdk')
const {getSubscriptionsContractState} = require('@reflector/reflector-shared/helpers/entries-helper')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const {getLastContractEvents} = require('../../utils/rpc-helper')
const {sha256, decrypt} = require('../../utils/crypto-helper')
const logger = require('../../logger')
const {getPreciseValue, calcCrossPrice} = require('../../utils/price-utils')
const container = require('../container')
const priceManager = require('../price-manager')
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


function assetToEventData(asset) {
    return {
        source: asset.source,
        asset: asset.asset.code
    }
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


/**
 * @param {Subscription} subscription - subscription
 * @param {Map<string, PriceData>} priceData - base price data
 * @returns {{price: BigInt, decimals: number}} - price and decimals
 */
function getPriceForPair(subscription, priceData) {
    if (!(priceData.has(subscription.base.source) && priceData.has(subscription.quote.source))) {
        logger.debug(`Price data for ${subscription.base.source} or/and ${subscription.quote.source} not found`)
        return {price: 0n, decimals: 0}
    }

    const {prices: basePrices, contract: baseContract} = priceData.get(subscription.base.source)
    const {
        baseAsset: baseAsset,
        decimals: baseDecimals,
        dataSource: baseDataSource,
        contractId: baseContractId
    } = baseContract

    const {prices: quotePrices, contract: quoteContract} = priceData.get(subscription.base.source)
    const {
        baseAsset: quoteBaseAsset,
        decimals: quoteDecimals,
        dataSource: quoteDataSource,
        contractId: quoteContractId
    } = quoteContract

    const {base, quote} = subscription

    if (!baseAsset.equals(quoteBaseAsset) || baseDecimals !== quoteDecimals || baseDataSource !== quoteDataSource)
        throw new Error(`Assets ${base.source}-${base.asset.toString()} and ${quote.source}-${quote.asset.toString()} are not compatible`)

    const {networkPassphrase} = container.settingsManager.getBlockchainConnectorSettings()

    const tryGetAssetIndex = (contract, asset) => contract.assets.findIndex(a => a.equals(asset, networkPassphrase))

    const isBaseAsset = (baseAsset, asset) => baseAsset.equals(asset, networkPassphrase)

    const baseIndex = tryGetAssetIndex(baseContract, base.asset)
    if (baseIndex < 0 && !isBaseAsset(baseAsset, base.asset))
        throw new Error(`Asset ${base.asset.toString()} not found in contract ${baseContractId}`)
    const quoteIndex = tryGetAssetIndex(quoteContract, quote.asset)
    if (quoteIndex < 0 && !isBaseAsset(quoteBaseAsset, quote.asset))
        throw new Error(`Asset ${quote.asset.toString()} not found in contract ${quoteContractId}`)

    if (base.source === quote.source && base.asset.equals(quote.asset, networkPassphrase)) {
        return getPreciseValue(1n, baseDecimals)
    }

    let price = 0n
    if (baseIndex < 0) //base asset is the contract's base asset
        price = quotePrices[quoteIndex]
    else if (quoteIndex < 0) //Quote asset is the contract's base asset
        price = calcCrossPrice(getPreciseValue(1n, baseDecimals), basePrices[baseIndex], baseDecimals)
    else
        price = calcCrossPrice(basePrices[baseIndex], quotePrices[quoteIndex], baseDecimals)
    return {price, decimals: baseDecimals}
}

const minuteMs = 60 * 1000

const day = 24 * 60 * 60 * 1000

class SubscriptionContractManager {

    constructor(contractId) {
        this.contractId = contractId
    }

    isRunning = false

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

    __getSourceContracts() {
        const {settingsManager} = container
        const {dataSources} = container.settingsManager.getContractConfig(this.contractId)
        const allOracles = [...settingsManager.config.contracts.values()]
            .filter(c => c.type === ContractTypes.ORACLE)
        if (dataSources === '*')
            return allOracles
        return allOracles.filter(c => dataSources.indexOf(c.contractId) >= 0)
    }

    /**
     * @param {number} timestamp - timestamp
     * @returns {Promise<Map<string, PriceData>>}
     */
    async __getPriceData(timestamp) {
        const contracts = this.__getSourceContracts()
        const prices = new Map()
        const promises = []
        for (const contract of contracts) {
            const pricesPromise = priceManager.getPrices(contract.contractId, timestamp, minuteMs)
                .then(contractPrices => {
                    prices.set(contract.contractId, {contract, prices: contractPrices})
                })
                .catch(e => {
                    logger.error(`Error getting prices for contract ${contract.contractId}: ${e.message}`)
                })
            promises.push(pricesPromise)
        }
        await Promise.all(promises)
        return prices
    }

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

    async __processLastEvents() {
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

    async start() {
        await this.__loadSubscriptionsData()
        this.isRunning = true
    }

    stop() {
        this.isRunning = false
    }

    /**
     * @param {number} timestamp - timestamp
     * @returns {Promise<EventsContainer>}
     */
    async getSubscriptionActions(timestamp) {
        //load last events
        await this.__processLastEvents(timestamp)
        //load prices for all contracts for the current timestamp
        const prices = await this.__getPriceData(timestamp)

        const syncData = this.__lastSyncData?.getSyncDataCopy() || {}

        const eventsContainer = new EventsContainer(this.contractId, timestamp, syncData)
        for (const subscription of this.__subscriptions.values()) {
            if (!this.isRunning)
                break
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

                const {price, decimals} = getPriceForPair(subscription, prices)
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
    const manager = subscriptionManager.get(contractId)
    if (manager)
        manager.stop()
    subscriptionManager.delete(contractId)
}

module.exports = {
    getManager,
    removeManager
}