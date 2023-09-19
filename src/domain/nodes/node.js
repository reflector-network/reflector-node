const {Keypair} = require('soroban-client')
const logger = require('../../logger')
const ChannelTypes = require('../../ws-server/channels/channel-types')
const container = require('../container')
const MessageTypes = require('../message-types')
const NodeStates = require('./node-states')

/**
 * @typedef {import('../../ws-server/channels/incoming-websocket-channel')} IncomingWebSocketChannel
 * @typedef {import('../../ws-server/channels/outgoing-websocket-channel')} OutgoingWebSocketChannel
 * @typedef {import('../../ws-server/channels/base-websocket-channel')} BaseWebSocketChannel
 */

class Node {
    /**
     * @type {IncomingWebSocketChannel}
     * @private
     */
    __incommingChannel = null

    /**
     * @type {OutgoingWebSocketChannel}
     * @private
     */
    __outgoingChannel = null

    /**
     * @param {string} pubkey - the public key of the node
     */

    constructor(pubkey) {
        if (!pubkey)
            throw new Error('Node public key is required')
        this.pubkey = pubkey
        this.keypair = Keypair.fromPublicKey(pubkey)
    }

    get url() {
        return this.__outgoingChannel?.url
    }

    /**
     * @param {message} message - the message to send
     * @param {ChannelTypes} channelType - the channel type
     */
    async send(message, channelType = ChannelTypes.INCOMING) {
        const channel = this.__getChannel(channelType)
        if (!channel?.isReady)
            throw new Error(`Channel ${channelType} is not ready`)
        await channel.send(message)
    }

    /**
     * @param {IncomingWebSocketChannel} connection - the incoming websocket from the node
     */
    assignIncommingWebSocket(connection) {
        this.__incommingChannel?.close(1001, 'New connection', true)
        this.__incommingChannel = connection
        setTimeout(async () => {
            try {
                await this.send({
                    type: MessageTypes.STATE,
                    data: {state: NodeStates.READY}
                })
            } catch (err) {
                logger.error(err)
            }
        }, 1000)

    }

    /**
     * @param {ChannelTypes} channelType - the channel type
     * @returns {boolean}
     */
    isReady(channelType) {
        const channel = this.__getChannel(channelType)
        return channel?.isReady
    }

    /**
     * @param {OutgoingWebSocketChannel} connection - reflector node connection
     */
    assignOutgoingWebSocket(connection) {
        this.__outgoingChannel?.close(1000, 'New connection', true)
        this.__outgoingChannel = connection
        const {settingsManager} = container
        settingsManager.updateNodeUrl(this.pubkey, this.__outgoingChannel.url)
    }

    /**
     * Close the node
     */
    close() {
        try {
            if (this.timeoutId)
                clearTimeout(this.timeoutId)
            this.__incommingChannel?.close(1001, 'Node closed', true)
            this.__outgoingChannel?.close(1000, 'Node closed', true)
        } catch (err) {
            logger.error(`${this.pubkey} websocket error on close`)
            logger.error(err)
        }
    }

    /**
     * @param {ChannelTypes} channelType - the channel type
     * @returns {BaseWebSocketChannel}
     * */

    __getChannel(channelType) {
        switch (channelType) {
            case ChannelTypes.INCOMING: {
                return this.__incommingChannel
            }
            case ChannelTypes.OUTGOING: {
                return this.__outgoingChannel
            }
            default:
                return null
        }
    }
}

module.exports = Node