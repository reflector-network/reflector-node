const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const MessageTypes = require('../../domain/message-types')
const BaseHandler = require('./base-handler')

/**
 * @typedef {import('../channels/base-websocket-channel')} BaseWebSocketChannel
 */

class HandshakeRequestHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING | ChannelTypes.INCOMING

    allowAnonymous = true

    /**
     * @param {BaseWebSocketChannel} channel - channel
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const authPayload = message.data?.payload
        if (!authPayload)
            throw new Error('Payload is required')
        const {keypair} = container.settingsManager.config
        const signature = keypair.sign(Buffer.from(authPayload)).toString('hex')
        return Promise.resolve({type: MessageTypes.HANDSHAKE_RESPONSE, data: {signature}})
    }
}

module.exports = HandshakeRequestHandler