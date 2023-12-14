const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const MessageTypes = require('../../domain/message-types')
const BaseHandler = require('./base-handler')

/**
 * @typedef {import('../channels/channel-base')} ChannelBase
 */

class HandshakeRequestHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING | ChannelTypes.INCOMING | ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    /**
     * @param {ChannelBase} channel - channel
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const authPayload = message.data?.payload
        if (!authPayload)
            throw new Error('Payload is required')
        const {keypair} = container.settingsManager.appConfig
        const signature = keypair.sign(Buffer.from(authPayload)).toString('hex')
        return Promise.resolve({type: MessageTypes.HANDSHAKE_RESPONSE, data: {signature}})
    }
}

module.exports = HandshakeRequestHandler