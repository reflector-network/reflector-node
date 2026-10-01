const {getSubscriptions, Asset, AssetType, getSubscriptionsContractState, compareStrings} = require('@reflector/reflector-shared')
const {scValToNative} = require('@stellar/stellar-sdk')
const {getLastContractEvents, getEventsLedgerInfo} = require('../../utils/rpc-helper')
const {decrypt} = require('../../utils/crypto-helper')
const {validateWebhookUrl} = require('../../utils/ssrf-validator')
const logger = require('../../logger')
const container = require('../container')
const dataSourceManager = require('../data-sources-manager')
const {maxVolumeDigits} = require('../prices/price-sync-validator')
const PendingSyncDataCache = require('./pending-notifications-cache')
const SubscriptionsSyncData = require('./subscriptions-sync-data')

let validSymbols = null
function getValidSymbols() {
    if (validSymbols === null) {
        validSymbols = container.validSymbols || require('./valid-symbols.json')
    }
    return validSymbols
}

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
 * @property {any} rawWebhook - raw webhook
 */

/**
 * @typedef {Object} SubscriptionAsset
 * @property {string} source - source
 * @property {Asset} asset - asset
 */

/**
 * @param {any} raw
 * @returns {SubscriptionAsset}
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

/**
 * @param {SubscriptionAsset} assetInfo
 * @returns {boolean}
 */
function isValidSymbol(assetInfo) {
    const validSymbols = getValidSymbols()
    const sourceValidSymbols = validSymbols[assetInfo.source]
    if (sourceValidSymbols === '*')
        return true
    else if (!(sourceValidSymbols instanceof Array)) {
        return false
    }
    return sourceValidSymbols.includes(assetInfo.asset.code)
}

/**
 * Parses a decrypted webhook list. A JSON.parse error message quotes a window of its input, and this input is the
 * subscriber's decrypted webhook, credentials and tokens included, so the parse error is replaced by a fixed one and
 * its text never reaches a log.
 * @param {string} rawWebhook - decrypted webhook text starting with `[`
 * @returns {any}
 */
function parseWebhookJson(rawWebhook) {
    try {
        return JSON.parse(rawWebhook)
    } catch (e) {
        throw new Error('Webhook payload is not valid JSON')
    }
}

async function getWebhook(id, webhookBuffer, contractId) {
    const {clusterSecretObject} = container.settingsManager
    if (!clusterSecretObject)
        return null
    const verifiedWebhook = []
    if (!(webhookBuffer && webhookBuffer.length))
        return verifiedWebhook
    try {
        //decrypt webhook
        const decrypted = await decrypt(clusterSecretObject, new Uint8Array(webhookBuffer))
        if (!decrypted)
            return null
        const rawWebhook = Buffer.from(decrypted).toString()
        if (!rawWebhook || !rawWebhook.length)
            return null
        const webhook = rawWebhook.startsWith('[') ? parseWebhookJson(rawWebhook) : rawWebhook.split(',').map(url => ({url}))
        if (webhook && !Array.isArray(webhook))
            throw new Error('Invalid webhook data')
        for (const webhookItem of webhook) {
            if (webhookItem.url) {
                try {
                    validateWebhookUrl(webhookItem.url)
                    verifiedWebhook.push(webhookItem)
                } catch (e) {
                    logger.error({msg: 'Invalid webhook URL for subscription', subscriptionId: id, contract: contractId, err: e.message})
                }
            }
        }
    } catch (e) {
        logger.error({msg: 'Error decrypting webhook', subscriptionId: id?.toString(), contract: contractId, err: e.message})
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

const minSyncDataEntries = 4096
const maxSyncDataSignatures = 128
const maxSignatureLength = 128 //base64 of a 64-byte ed25519 signature is 88 characters; 128 leaves room and bounds the string
const pubkeyLength = 56 //ed25519 strkey
const idPattern = /^(0|[1-9][0-9]{0,39})$/ //a subscription id is a u64, at most 20 digits
//lastPrice is the pair price an honest node computed, so its bound follows the volume bound the price sync accepts:
//getVWAP scales a volume by 10^decimals and calcCrossPrice scales the result by 10^decimals again, so a price runs
//up to 2 x decimals digits past the longest volume - 1028 digits at the default 14. The margin covers two scalings
//at up to 50 decimals. A lower bound rejects every honest node's SYNC item for a contract as soon as one
//subscription prices a long-volume token, which freezes sync and fires every subscription by heartbeat
const maxPriceDigits = maxVolumeDigits + 100
const pricePattern = new RegExp(`^(0|[1-9][0-9]{0,${maxPriceDigits - 1}})$`)
const maxSyncDataLookahead = 60 * 1000 //one subscriptions timeframe

/**
 * Validates the shape of a peer-supplied SYNC payload and rebuilds it with exactly the fields the hash covers, so
 * padding a payload cannot change its hash and a malformed one never reaches shared state.
 * @param {any} rawSyncData - payload from the SYNC message
 * @param {number} maxEntries - ceiling on the number of syncData keys the caller is prepared to hold
 * @returns {{data: {syncData: Object.<string, {lastNotification: number, lastPrice: string}>, timestamp: number}, signatures: {pubkey: string, signature: string}[]}}
 */
function parseRawSyncData(rawSyncData, maxEntries) {
    if (!rawSyncData || typeof rawSyncData !== 'object')
        throw new Error('sync data is required')
    const {data, signatures} = rawSyncData
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('sync data payload must be an object')
    if (!Number.isSafeInteger(data.timestamp) || data.timestamp <= 0)
        throw new Error('sync data timestamp must be a positive integer')
    const {syncData} = data
    if (!syncData || typeof syncData !== 'object' || Array.isArray(syncData))
        throw new Error('syncData must be an object')
    const ids = Object.keys(syncData)
    if (ids.length > maxEntries)
        throw new Error(`syncData holds more than ${maxEntries} entries`)
    const normalizedSyncData = {}
    for (const id of ids) {
        if (!idPattern.test(id))
            throw new Error('syncData key must be a decimal subscription id')
        const entry = syncData[id]
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            throw new Error('syncData entry must be an object')
        if (Object.keys(entry).length !== 2)
            throw new Error('syncData entry must hold exactly lastNotification and lastPrice')
        if (!Number.isSafeInteger(entry.lastNotification) || entry.lastNotification < 0)
            throw new Error('lastNotification must be a non-negative integer')
        if (typeof entry.lastPrice !== 'string' || !pricePattern.test(entry.lastPrice))
            throw new Error('lastPrice must be a decimal integer string')
        normalizedSyncData[id] = {lastNotification: entry.lastNotification, lastPrice: entry.lastPrice}
    }
    if (!Array.isArray(signatures))
        throw new Error('signatures must be an array')
    if (signatures.length > maxSyncDataSignatures)
        throw new Error('too many signatures')
    //rebuilt field by field for the same reason the data is: an entry a peer padded is re-broadcast verbatim by
    //toPlainObject(), so only the two fields the cluster agreed on survive
    const normalizedSignatures = signatures.map(signature => {
        if (!signature || typeof signature !== 'object' || Array.isArray(signature))
            throw new Error('signature entry must be an object')
        if (typeof signature.pubkey !== 'string' || signature.pubkey.length !== pubkeyLength)
            throw new Error('signature pubkey must be a 56-character strkey')
        if (typeof signature.signature !== 'string' || signature.signature.length === 0 || signature.signature.length > maxSignatureLength)
            throw new Error('signature must be a bounded base64 string')
        return {pubkey: signature.pubkey, signature: signature.signature}
    })
    return {data: {syncData: normalizedSyncData, timestamp: data.timestamp}, signatures: normalizedSignatures}
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
     * Reads the subscriptions stored in the contract; writes nothing
     * @param {string[]} sorobanRpc - soroban rpc
     * @return {Promise<any[]>} raw subscriptions
     */
    async __readSubscriptionsData(sorobanRpc) {
        const {lastSubscriptionId} = await getSubscriptionsContractState(this.contractId, sorobanRpc)
        return await getSubscriptions(this.contractId, sorobanRpc, lastSubscriptionId)
    }

    /**
     * Replaces the local subscriptions with the ones read from the contract
     * @param {any[]} rawData - raw subscriptions
     * @return {Promise<void>}
     */
    async __applySubscriptionsData(rawData) {
        this.__subscriptions.clear()
        for (const raw of rawData)
            await this.__setSubscription(raw)
        logger.trace({msg: `Loaded subscriptions`, contract: this.contractId, count: this.__subscriptions.size})
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

            if (!(isValidSymbol(base) && isValidSymbol(quote))) {
                logger.warn({msg: 'Invalid symbol in subscription', subscriptionId: raw.id, contract: this.contractId, base: `${base.source}-${base.asset.code}`, quote: `${quote.source}-${quote.asset.code}`})
                return
            }

            if (!(dataSourceManager.has(base.source) && dataSourceManager.has(quote.source))) {//the source is not supported
                logger.debug({msg: 'Subscription source(s) not supported', subscriptionId: raw.id, contract: this.contractId})
                return
            }

            const webhook = await getWebhook(raw.id, raw.webhook, this.contractId)
            const subscription = {
                base,
                quote,
                balance: raw.balance,
                status: raw.status,
                id: raw.id,
                lastCharge: Number(raw.updated),
                owner: raw.owner,
                threshold: raw.threshold,
                rawWebhook: raw.webhook,
                webhook,
                heartbeat: raw.heartbeat
            }
            this.__subscriptions.set(subscription.id, subscription)
        } catch (err) {
            logger.error({err, rawSubscription: raw, msg: `Error on adding subscription ${raw?.id.toString()}, contract ${this.contractId}`})
        }
    }

    async __ensureWebhooksDecrypted() {
        for (const [id, subscription] of this.__subscriptions) {
            if (subscription.webhook !== null) //already decrypted
                continue
            //try to decrypt
            const updatedWebhook = await getWebhook(id, subscription.rawWebhook, this.contractId)
            subscription.webhook = updatedWebhook
        }
    }

    /**
     * The reads of a normal tick; writes nothing to this manager. When the last processed ledger has fallen out of the
     * rpc's event range it stops after the range check and says so, and the caller makes the full reload instead
     * @param {string[]} sorobanRpc - soroban rpc
     * @return {Promise<object>} {isOutOfRange, startLedger}, plus {events, lastLedger} when the cursor is in range
     */
    async __readLastEvents(sorobanRpc) {
        //get events ledger info
        const {oldestLedger, latestLedger} = await getEventsLedgerInfo(sorobanRpc, this.contractId)
        //check if out of range
        const isOutOfRange = oldestLedger > this.__lastLedger
        //determine start ledger
        const startLedger = isOutOfRange ? latestLedger - 360 : this.__lastLedger //if out of range, load last 360 ledgers
        logger.debug({msg: 'Processing events for contract', contract: this.contractId, oldestLedger, lastProcessedLedger: this.__lastLedger, latestLedger, isOutOfRange})
        if (isOutOfRange)
            return {isOutOfRange, startLedger}
        return {isOutOfRange, startLedger, ...await this.__readEvents(sorobanRpc, startLedger)}
    }

    /**
     * Reads the contract events from a ledger on; writes nothing
     * @param {string[]} sorobanRpc - soroban rpc
     * @param {number} startLedger - ledger to read from
     * @return {Promise<{events: any[], lastLedger: number}>}
     */
    async __readEvents(sorobanRpc, startLedger) {
        logger.debug({msg: 'Processing events', contract: this.contractId, startLedger})
        const {events, lastLedger} = await loadLastEvents(this.contractId, startLedger, sorobanRpc)
        logger.debug({msg: 'Loaded events', contract: this.contractId, count: events.length, newLastLedger: lastLedger})
        return {events, lastLedger}
    }

    /**
     * The reads of a full reload: every subscription the contract stores, then the events from the reload's start
     * ledger. Writes nothing
     * @param {string[]} sorobanRpc - soroban rpc
     * @param {number} startLedger - ledger to read the events from
     * @return {Promise<{rawSubscriptions: any[], events: any[], lastLedger: number}>}
     */
    async __readFullReload(sorobanRpc, startLedger) {
        logger.debug({msg: 'Initializing subscriptions data', contract: this.contractId, lastProcessedLedger: this.__lastLedger, startLedger, isInitialized: this.__isInitialized})
        const rawSubscriptions = await this.__readSubscriptionsData(sorobanRpc)
        return {rawSubscriptions, ...await this.__readEvents(sorobanRpc, startLedger)}
    }

    /**
     * @param {Function} [bound] - bounds the reads of a normal tick, which are already started when it receives them;
     * the default leaves them unbounded. A full reload is never bounded by it
     * @return {Promise<boolean>} true when this call made a full reload
     */
    async processLastEvents(bound = reads => reads) {
        //get rpc
        const {settingsManager} = container
        const {sorobanRpc} = settingsManager.getBlockchainConnectorSettings()

        //every rpc read comes first and writes nothing, so reads a deadline abandoned cannot change this manager when
        //they answer late: only the code below writes it, and it runs only once the reads have resolved
        const read = await bound(this.__readLastEvents(sorobanRpc))
        //the full reload - on the first tick after boot, and whenever the cursor falls out of the rpc's event range -
        //takes ceil(lastSubscriptionId / 50) sequential batches, which no fixed tick budget covers as the contract grows:
        //a budget would time out every tick and the node would never initialise (N-1). So it is not bounded; each
        //request still carries its own rpc deadline. It runs inside this worker, so ticks stay serial, and the
        //subscriptions and the ledger cursor are applied together only once every read has come back, so a reload that
        //fails partway applies nothing and the next tick starts it again
        const reload = read.isOutOfRange ? await this.__readFullReload(sorobanRpc, read.startLedger) : null
        if (reload) {
            await this.__applySubscriptionsData(reload.rawSubscriptions)
            logger.debug({msg: 'Subscriptions data initialized', contract: this.contractId, count: this.__subscriptions.size})
        }
        const {events, lastLedger} = reload || read
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
                            logger.debug({msg: 'Processing subscription event', subscriptionId: id, eventTopic, contract: this.contractId})
                            rawSubscription.id = id
                            await this.__setSubscription(rawSubscription)
                        }
                        break
                    case 'suspended':
                    case 'cancelled':
                        {
                            const id = event.value[0] || event.value
                            logger.debug({msg: 'Subscription event', subscriptionId: id, eventTopic, contract: this.contractId})
                            if (this.__subscriptions.has(id))
                                this.__subscriptions.delete(id)
                        }
                        break
                    case 'charged':
                        {
                            const id = event.value[0]
                            const timestamp = event.value[2]
                            logger.debug({msg: 'Subscription charged', subscriptionId: id, contract: this.contractId})
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
                        logger.error({msg: 'Unknown event type', eventTopic, contract: this.contractId})
                }
            } catch (e) {
                logger.error({msg: 'Error processing event', topic: event.topic, contract: this.contractId, err: e.message})
            }
        }

        //make sure that all webhooks are set
        await this.__ensureWebhooksDecrypted()
        return !!reload
    }

    /**
     * @param {any} rawSyncData - payload from the SYNC message
     * @param {string} sender - public key of the authenticated peer that sent it
     */
    async trySetRawSyncData(rawSyncData, sender) {
        try {
            //syncData accumulates one entry per subscription that has ever triggered and is never pruned, so the cap is
            //derived from the set the cluster has already agreed on rather than from the live subscription count, which
            //churn leaves far behind. __lastSyncData only advances on a majority-signed item, so a peer cannot ratchet
            //the cap on its own; the headroom is the live count because only a live subscription can newly trigger this
            //tick (subscriptions-processor.js:169), which bounds honest growth exactly
            const maxEntries = Math.max(minSyncDataEntries, (this.__lastSyncData?.size || 0) + this.__subscriptions.size)
            const {data, signatures} = parseRawSyncData(rawSyncData, maxEntries)
            const newSyncData = new SubscriptionsSyncData(data)
            await newSyncData.calculateHash()
            newSyncData.tryAddSignature(signatures)
            this.trySetSyncData(newSyncData, sender)
        } catch (e) {
            //warn, not debug: a rejection is the only signal an operator gets that peer sync has stopped merging
            logger.warn({msg: 'Rejected raw sync data', contract: this.contractId, err: e.message})
        }
    }

    /**
     * @param {SubscriptionsSyncData} newSyncData - sync data
     * @param {string} sender - public key of the node it came from, charged for any pending entry it opens
     */
    trySetSyncData(newSyncData, sender) {
        //a payload dated in the future would pin __lastSyncData for the life of the process, because adoption requires
        //a non-decreasing timestamp. There is no lower bound: a restarted node recovers old state from peers.
        if (newSyncData.timestamp > Date.now() + maxSyncDataLookahead) {
            logger.debug({msg: 'Sync data timestamp is too far ahead', contract: this.contractId, timestamp: newSyncData.timestamp})
            return
        }
        //an adopted item has left the pending cache, so a later copy of it adds its signatures here instead of opening a
        //pending entry of its own - what the cache did while adopted items stayed in it
        if (this.__lastSyncData && newSyncData.hashBase64 === this.__lastSyncData.hashBase64) {
            this.__lastSyncData.merge(newSyncData)
            return
        }
        const syncItem = this.__pendingSyncData.push(newSyncData, sender)
        const lastTimestamp = this.__lastSyncData?.timestamp || 0
        if (syncItem.isVerified && syncItem.timestamp >= lastTimestamp) {
            this.__lastSyncData = syncItem
            logger.debug({msg: 'New sync data set for contract', contract: this.contractId, timestamp: syncItem.timestamp, hash: syncItem.hashBase64, signatures: syncItem.__signatures.map(s => s.pubkey).join(',')})
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
        .sort((a, b) => compareStrings(a.contractId, b.contractId)) //code-unit order, never the process locale
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