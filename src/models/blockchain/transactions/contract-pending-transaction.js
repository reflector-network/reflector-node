const PendingTransactionBase = require('./pending-transaction-base')
const PendingTransactionType = require('./pending-transaction-type')

class ContractPendingTransaction extends PendingTransactionBase {
    /**
     * @param {Transaction} transaction - transaction hash
     * @param {number} timestamp - transaction timestamp
     * @param {BigInt} wasmHash - contract wasm hash
     */
    constructor(transaction, timestamp, wasmHash) {
        super(transaction, timestamp, PendingTransactionType.CONTRACT_UPDATE)
        if (!wasmHash || wasmHash.length !== 64)
            throw new Error('wasmHash is not valid')
        this.wasmHash = wasmHash
    }

    /**
     * @type {BigInt}
     */
    wasmHash

    getDebugInfo() {
        return `Contract update: ${this.period}, timestamp: ${this.timestamp}, type: ${this.type}, hash: ${this.hashHex}`
    }
}

module.exports = ContractPendingTransaction