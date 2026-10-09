const {Keypair} = require('@stellar/stellar-sdk')
const ChannelTypes = require('../channels/channel-types')
const BaseHandler = require('./base-handler')

/**
 * @typedef {import('../channels/channel-base')} ChannelBase
 */

class HandshakeResponseHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.OUTGOING, ChannelTypes.INCOMING]

    allowAnonymous = true

    /**
     * Verifies the peer's signature over our challenge. Throws so the pending HANDSHAKE_REQUEST rejects instead
     * of resolving; WsServer relies on that and on channel.isValidated before registering the connection.
     * @param {ChannelBase} channel - channel
     * @param {any} message - message to handle
     */
    handle(channel, message) {
        const signature = message.data?.signature
        if (!signature) {
            channel.close(1008, 'Invalid signature', true)
            throw new Error('Signature is required')
        }
        const kp = Keypair.fromPublicKey(channel.pubkey)
        let isValid = false
        try {
            isValid = kp.verify(Buffer.from(channel.authPayload), Buffer.from(signature, 'hex'))
        } catch (e) {
            isValid = false
        }
        if (!isValid) {
            channel.close(1008, 'Invalid signature', true)
            throw new Error('Invalid signature')
        }
        channel.validated()
    }
}

module.exports = HandshakeResponseHandler