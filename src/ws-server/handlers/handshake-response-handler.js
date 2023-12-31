const {Keypair} = require('soroban-client')
const ChannelTypes = require('../channels/channel-types')
const BaseHandler = require('./base-handler')

/**
 * @typedef {import('../channels/base-websocket-channel')} BaseWebSocketChannel
 */


class HandshakeResponseHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING | ChannelTypes.INCOMING

    allowAnonymous = true

    /**
     * @param {BaseWebSocketChannel} channel - channel
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const {signature} = message.data
        const kp = Keypair.fromPublicKey(channel.pubkey)
        if (!kp.verify(Buffer.from(channel.authPayload), Buffer.from(signature, 'hex'))) {
            channel.close(1008, 'Invalid signature', true)
            return
        }
        channel.validated()
    }
}

module.exports = HandshakeResponseHandler