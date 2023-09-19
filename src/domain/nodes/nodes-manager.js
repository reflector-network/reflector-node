const ChannelTypes = require('../../ws-server/channels/channel-types')
const logger = require('../../logger')
const WsServer = require('../../ws-server')
const container = require('../container')
const SettingsManager = require('../settings-manager')
const Node = require('./node')

/**
 * @typedef {import('../ws-server/channels/incoming-websocket-channel')} IncomingWebSocketChannel
 * @typedef {import('soroban-client').Keypair} Keypair
 * @typedef {import('../../models/config')} Config
 */

class NodesManager {

    constructor() {
        this.__connectionHandler = this.__onConnection.bind(this)
        this.__nodesUpdateHandler = this.__updateNodes.bind(this)
    }

    /**
     * @type {{[pubkey: string]: Node}}
     * @private
     */
    __nodes = null

    /**
     * @type {{pubkey: string, url: string, confirmedUrl: boolean}[]}}
     */
    __pendingNodeUrls = null

    start() {
        if (this.isRunning)
            return
        const {settingsManager, webSocketServer} = container
        this.pubkey = settingsManager.config.publicKey
        this.__pendingNodeUrls = []
        this.__nodes = {}
        webSocketServer.on(WsServer.EVENTS.CONNECTION, this.__connectionHandler)
        settingsManager.on(SettingsManager.EVENTS.NODES_UPDATED, this.__nodesUpdateHandler)
        this.isRunning = true
        this.__updateNodes()
        this.__processPendingNodes()
    }

    __updateNodes() {
        const {settingsManager} = container
        const confirmedNodes = []
        for (const node of settingsManager.nodeAddresses) {
            if (settingsManager.contractSettings.nodes.includes(node.pubkey))
                confirmedNodes.push(node)
        }
        for (const node of Object.values(this.__nodes)) { //close nodes that were removed
            if (!confirmedNodes.find(x => x.pubkey === node.pubkey)) {
                node.close()
                delete this.__nodes[node.pubkey]
            }
        }
        //try to connect to new nodes/addresses
        this.addNodes(confirmedNodes, true)
    }


    /**
     * Add nodes to the manager
     * @param {{pubkey: string, url: string}[]} nodes - array of nodes
     * @param {boolean} createIfNotExists - create the node if not exists
     */
    addNodes(nodes, createIfNotExists = false) {
        //ignore current node
        for (const {pubkey, url} of nodes.filter(x => x.pubkey !== this.pubkey)) {
            let node = this.__nodes[pubkey]
            if (!node) {
                if (!createIfNotExists)
                    continue
                this.__nodes[pubkey] = node = new Node(pubkey)
            }
            if (url && node.url !== url)
                this.__pendingNodeUrls.push({pubkey, url, confirmedUrl: createIfNotExists})
        }
    }

    getConnectedNodes() {
        if (!this.isRunning)
            return []
        return Object.values(this.__nodes).filter(n => n.isReady(ChannelTypes.OUTGOING)).map(n => n.pubkey)
    }

    async broadcast(message) {
        const broadcasted = []
        for (const node of Object.values(this.__nodes))
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
     * @param {IncomingWebSocketChannel} connection - new connection
     */
    __onConnection(connection) {
        const node = this.__nodes[connection.pubkey]
        if (!node) {
            connection.close(1001, 'Unauthorized')
            return
        }
        node.assignIncommingWebSocket(connection)
    }

    async __processPendingNodes() {
        if (!this.isRunning)
            return
        while (this.__pendingNodeUrls.length > 0) {
            const {pubkey, url, confirmedUrl} = this.__pendingNodeUrls.shift()
            await this.__addNode(pubkey, url, confirmedUrl)
        }
        //Sleep for a while before the next iteration
        this.__pendingNodesTimeout = setTimeout(() => this.__processPendingNodes(), 5000)
    }

    async __addNode(pubkey, url, confirmedUrl = false) {
        if (pubkey === this.pubkey || !url) //ignore current node and empty urls
            return
        const node = this.__nodes[pubkey]
        if (!node) {
            return
        }
        const maxConnectionAttempts = confirmedUrl ? 0 : 1
        const isNewUrl = node.url !== url
        const canConnect = !node.isReady(ChannelTypes.OUTGOING) || confirmedUrl
        if (isNewUrl && canConnect) {
            const connection = container.webSocketServer.getNewConnection(url, pubkey)
            try {
                await connection.connect(maxConnectionAttempts)
            } catch (err) {
                if (!confirmedUrl) {
                    connection.close(1000, err.message, true)
                    return
                }
                logger.debug(err)
            }
            node.assignOutgoingWebSocket(connection)
        }
    }

    stop() {
        if (!this.isRunning)
            return
        this.isRunning = false
        container.webSocketServer.off(WsServer.EVENTS.CONNECTION, this.__connectionHandler)
        container.settingsManager.off(SettingsManager.EVENTS.NODES_UPDATED, this.__nodesUpdateHandler)
        for (const node of Object.values(this.__nodes))
            node.close()
        this.__nodes = null
        this.__pendingNodeUrls = null
        this.__pendingNodesTimeout && clearTimeout(this.__pendingNodesTimeout)
    }
}

module.exports = NodesManager