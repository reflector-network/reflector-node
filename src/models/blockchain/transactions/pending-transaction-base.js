const {hasMajority, getMajority} = require('../../../utils/majority-helper')
const PendingTransactionType = require('./pending-transaction-type')

const pendingTxTypeValues = Object.values(PendingTransactionType)

/**
 * @typedef {import('soroban-client').xdr.DecoratedSignature} DecoratedSignature
 * @typedef {import('soroban-client').Transaction} Transaction
 */

class PendingTransactionBase {

    /**
     * @param {Transaction} transaction - transaction hash
     * @param {number} timestamp - transaction timestamp
     * @param {number} type - transaction type
     */
    constructor(transaction, timestamp, type) {
        //instance of this abstract class cannot be created
        if (this.constructor === PendingTransactionBase)
            throw new Error('PendingTransactionBase is abstract class')
        if (!transaction)
            throw new Error('transaction is required')
        if (!timestamp)
            throw new Error('timestamp is required')
        if (!pendingTxTypeValues.includes(type))
            throw new Error('type is required')
        this.timestamp = timestamp
        this.transaction = transaction
        this.hash = transaction.hash()
        this.hashHex = this.hash.toString('hex')
        this.type = type
        this.signatures = []
    }

    /**
     * @type {Transaction}
     */
    transaction

    /**
     * @type {number}
     */
    type

    /**
     * @type {Buffer}
     */
    hash

    /**
     * @type {string}
     */
    hashHex

    /**
     * @type {DecoratedSignature[]}
     */
    signatures

    /**
     * @type {boolean}
     */
    isSigned = false

    /**
     * @param {DecoratedSignature} signature - hex encoded signature
     */
    addSignature(signature) {
        this.signatures.push(signature)
    }

    signTransaction(totalSignersCount) {
        for (const signature of this.getMajoritySignatures(totalSignersCount))
            this.transaction.signatures.push(signature)

        this.isSigned = true
    }

    getMajoritySignatures(totalSignersCount) {
        return this.signatures.slice(0, getMajority(totalSignersCount))
    }

    /**
     * @param {number} totalSignersCount - total signers count
     * @param {string} networkPassphrase - network passphrase
     * @returns {boolean}
     */
    isReadyToSubmit(totalSignersCount) {
        return hasMajority(totalSignersCount, this.signatures.length)
    }

    getDebugInfo() {
        return `${this.hashHex} (${this.type})`
    }
}

module.exports = PendingTransactionBase