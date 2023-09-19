const PendingTransactionBase = require('./pending-transaction-base')
const PendingTransactionType = require('./pending-transaction-type')

class NodesPendingTransaction extends PendingTransactionBase {
    /**
     * @param {Transaction} transaction - transaction hash
     * @param {number} timestamp - transaction timestamp
     * @param {{node: string, remove: boolean}[]} nodes - nodes update
     */
    constructor(transaction, timestamp, nodes) {
        super(transaction, timestamp, PendingTransactionType.NODES_UPDATE)
        if (!nodes || !nodes.length)
            throw new Error('nodes is required')
        this.nodes = nodes
    }

    /**
     * @type {{node: string, remove: boolean}[]}
     */
    nodes

    getDebugInfo() {
        return `Nodes update: ${this.nodes.map(n => `${n.pubkey}:${n.url}:${!!n.remove}`).join(', ')}, timestamp: ${this.timestamp}, type: ${this.type}, hash: ${this.hashHex}`
    }
}

module.exports = NodesPendingTransaction