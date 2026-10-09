const {Keypair} = require('@stellar/stellar-sdk')
const {hasMajority, sortObjectKeys} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const {sha256} = require('../../utils/crypto-helper')


class SubscriptionsSyncData {
    constructor(rawSyncData) {
        if (!rawSyncData)
            throw new Error('rawSyncData is required')
        this.__data = rawSyncData
    }

    /**
     * @type {Buffer}
     */
    hash = null

    /**
     * @type {string}
     */
    hashBase64 = null

    /**
     * @type {{syncData: {[string]: {lastNotification: number, lastPrice: string}}, timestamp: number}}
     */
    __data = {syncData: {}, timestamp: 0}

    /**
     * @type {{pubkey: string, signature: string}[]}
     */
    __signatures = []

    /**
     * @type {boolean}
     */
    __isVerified = false

    async calculateHash() {
        this.hash = Buffer.from(await sha256(Buffer.from(JSON.stringify(sortObjectKeys(this.__data)))))
        this.hashBase64 = this.hash.toString('base64')
    }

    /**
     * Adds every signature of the batch that a current cluster member produced. A signer outside the node set is
     * skipped before its signature is verified.
     * @param {{pubkey: string, signature: string}[]} signaturesData - signatures data
     * @param {boolean} [verified] - are signatures verified
     */
    tryAddSignature(signaturesData, verified = false) {
        const {nodes} = container.settingsManager.config
        for (const signatureData of signaturesData) {
            const {signature, pubkey} = signatureData
            if (!nodes.has(pubkey)) { //only current cluster members count toward the majority
                logger.debug({msg: 'Sync data signature from a key outside the cluster', timestamp: this.timestamp, pubkey})
                continue
            }
            if (this.__signatures.findIndex(s => s.pubkey === pubkey) >= 0) //prevent duplicate signatures
                continue
            if (!verified && (typeof signature !== 'string'
                || !Keypair.fromPublicKey(pubkey).verify(this.hash, Buffer.from(signature, 'base64')))) {
                logger.debug({msg: 'Invalid signature for timestamp', timestamp: this.timestamp, pubkey})
                continue
            }
            //add valid signature
            this.__signatures.push(signatureData)

            //check if verified
            this.__isVerified = this.__isVerified || hasMajority(nodes.size, this.__signatures.length)
        }
    }

    /**
     * @param {Keypair} keypair - keypair to sign the data
     */
    sign(keypair) {
        const signature = Buffer.from(keypair.sign(this.hash)).toString('base64')
        this.tryAddSignature([{pubkey: keypair.publicKey(), signature}], true)
    }


    /**
     * @param {SubscriptionsSyncData} other - other data to merge
     */
    merge(other) {
        this.tryAddSignature(other.__signatures, true)
    }

    /**
     * @returns {Object.<string, {lastNotification: number, lastPrice: string}>} - syncData data copy
     */
    getSyncDataCopy() {
        return JSON.parse(JSON.stringify(this.__data.syncData))
    }

    toPlainObject() {
        return {
            data: this.__data,
            signatures: this.__signatures
        }
    }

    /**
     * Number of subscriptions this sync data holds an entry for. Once the item is verified the cluster has agreed on
     * exactly these entries, so it is the only peer-independent measure of how large an honest payload may be.
     * @returns {number}
     */
    get size() {
        return Object.keys(this.__data.syncData).length
    }

    /**
     * @returns {number}
     */
    get timestamp() {
        return this.__data.timestamp
    }

    /**
     * @returns {boolean}
     */
    get isVerified() {
        return this.__isVerified
    }
}

module.exports = SubscriptionsSyncData