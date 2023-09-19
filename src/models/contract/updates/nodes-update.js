const UpdateBase = require('./update-base')
const UpdateType = require('./update-type')

class NodesUpdate extends UpdateBase {

    /**
     * @param {BigInt} timestamp - pending update timestamp
     * @param {{node: string, url: string, removed: boolean}[]} nodes - pending update nodes
     */
    constructor(timestamp, nodes) {
        super(UpdateType.NODES, timestamp)
        if (!nodes || !nodes.length)
            throw new Error('nodes is required')
        this.nodes = nodes
    }

    toPlainObject() {
        return {
            ...super.toPlainObject(),
            nodes: this.nodes
        }
    }
}

module.exports = NodesUpdate