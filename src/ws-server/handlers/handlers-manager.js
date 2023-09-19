const MessageTypes = require('../../domain/message-types')
const HandshakeRequestHandler = require('./handshake-request-handler')
const HandshakeResponseHandler = require('./handshake-response-handler')
const SettingsHandler = require('./settings-handler')
const SignaturesHandler = require('./signatures-handler')
const StateHandler = require('./state-handler')

/**
 * @typedef {import('../channels/base-websocket-channel')} BaseWebSocketChannel
 */

class HandlersManager {

    constructor() {
        this.handlers = {
            [MessageTypes.HANDSHAKE_REQUEST]: new HandshakeRequestHandler(),
            [MessageTypes.HANDSHAKE_RESPONSE]: new HandshakeResponseHandler(),
            [MessageTypes.SETTINGS]: new SettingsHandler(),
            [MessageTypes.STATE]: new StateHandler(),
            [MessageTypes.SIGNATURE]: new SignaturesHandler()
        }
    }

    /**
     * @param {BaseWebSocketChannel} channel - channel type
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const handler = this.handlers[message.type]
        if (!handler)
            throw new Error(`Message type ${message.type} is not supported`)
        if (!handler.allowAnonymous && !channel.isValidated)
            throw new Error(`Message type ${message.type} is not allowed for anonymous channel`)
        if (!handler.allowedChannelTypes & channel)
            throw new Error(`Message type ${message.type} is not supported for channel ${channel}`)
        return await handler.handle(channel, message)
    }
}

module.exports = HandlersManager