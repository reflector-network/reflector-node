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
     * @param {{pubkey: string, signature: string}[]} signaturesData - signatures data
     * @param {boolean} [verified] - are signatures verified
     */
    tryAddSignature(signaturesData, verified = false) {
        for (const signatureData of signaturesData) {
            const {signature, pubkey} = signatureData
            if (this.__signatures.findIndex(s => s.pubkey === pubkey) >= 0) //prevent duplicate signatures
                return
            if (!verified && !Keypair.fromPublicKey(pubkey).verify(this.hash, Buffer.from(signature, 'base64'))) {
                logger.debug(`Invalid signature for timestamp ${this.__timestamp} from ${pubkey}`)
                return
            }
            //add valid signature
            this.__signatures.push(signatureData)

            //check if verified
            this.__isVerified = this.__isVerified || hasMajority(container.settingsManager.config.nodes.size, this.__signatures.length)
        }
    }

    /**
     * @param {Keypair} keypair - keypair to sign the data
     */
    sign(keypair) {
        const signature = keypair.sign(this.hash).toString('base64')
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