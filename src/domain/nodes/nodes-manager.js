const ChannelTypes = require('../../ws-server/channels/channel-types')
const logger = require('../../logger')
const Node = require('./node')
const OutgoingChannel = require('../../ws-server/channels/outgoing-channel')
const container = require('../container')

/**
 * @typedef {import('../../ws-server/channels/incoming-channel')} IncomingChannel
 * @typedef {import('@reflector/reflector-shared').Node} ConfigNode
 */

class NodesManager {
    /**
     * @type {Map<String, Node>}
     * @private
     */
    __nodes = new Map()

    getConnectedNodes() {
        return this.__nodes.values().filter(n => n.isReady(ChannelTypes.OUTGOING)).map(n => n.pubkey)
    }

    async broadcast(message) {
        const broadcasted = []
        for (const node of this.__nodes.values())
            broadcasted.push(this.sendTo(node.pubkey, message))
        await Promise.allSettled(broadcasted)
    }

    async sendTo(pubkey, message) {
        const node = this.__nodes[pubkey]
        if (!node)
            return
        try {
            if (node.isReady(ChannelTypes.OUTGOING))
                await node.send(message, ChannelTypes.OUTGOING)
        } catch (err) {
            logger.error(`Error sending message ${message.type} to ${pubkey}`)
            logger.error(err)
        }
    }

    /**
     * Add new connection
     * @param {IncomingChannel} connection - new connection
     */
    addConnection(connection) {
        const node = this.__nodes[connection.pubkey]
        if (!node) {
            connection.close(1001, 'Unauthorized')
            return
        }
        node.assignIncommingWebSocket(connection)
    }

    /**
     * @param {Map<string, ConfigNode>}} nodes - nodes from settings
     */
    setNodes(configNodes) {
        const allNodePubkeys = new Set([...configNodes.keys(), ...this.__nodes.keys()])
        for (const pubkey of allNodePubkeys) {
            if (pubkey === container.settingsManager.appConfig.publicKey) //skip self
                continue
            const settingsNode = configNodes.get(pubkey)
            const currentNode = this.__nodes.get(pubkey)
            if (!settingsNode) {
                const node = this.__nodes.get(pubkey)
                node.close()
                this.__nodes.delete(pubkey)
                continue
            }
            if (!currentNode) {
                const node = new Node(pubkey)
                this.__nodes.set(pubkey, node)
            }
            if (settingsNode.url === currentNode?.url)
                continue
            const node = this.__nodes.get(pubkey)
            node.assignOutgoingWebSocket(settingsNode.url ? new OutgoingChannel(pubkey, settingsNode.url) : null)
        }
    }
}

module.exports = new NodesManager()