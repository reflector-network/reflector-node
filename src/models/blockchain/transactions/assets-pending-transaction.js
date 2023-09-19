const PendingTransactionBase = require('./pending-transaction-base')
const PendingTransactionType = require('./pending-transaction-type')

/**
 * @typedef {import('../../assets/asset')} Asset
 */

class AssetsPendingTransaction extends PendingTransactionBase {
    /**
     * @param {Transaction} transaction - transaction hash
     * @param {number} timestamp - transaction timestamp
     * @param {Asset[]} assets - assets update
     */
    constructor(transaction, timestamp, assets) {
        super(transaction, timestamp, PendingTransactionType.ASSETS_UPDATE)
        if (!assets || !assets.length)
            throw new Error('assets is required')
        this.assets = assets
    }

    /**
     * @type {Asset[]}
     */
    assets

    getDebugInfo() {
        return `Assets update: ${this.assets.map(a => a.code).join(', ')}, timestamp: ${this.timestamp}, type: ${this.type}, hash: ${this.hashHex}`
    }
}

module.exports = AssetsPendingTransaction