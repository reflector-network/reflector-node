const {v4: uuidv4} = require('uuid')
const MessageTypes = require('../handlers/message-types')
const logger = require('../../logger')
const OutgoingChannelBase = require('./outgoing-channel-base')
const ChannelTypes = require('./channel-types')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class OutgoingChannel extends OutgoingChannelBase {

    type = ChannelTypes.OUTGOING

    __connect() {
        this.authPayload = uuidv4()
        super.__connect()
    }

    __onOpen() {
        super.__onOpen()
        this.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: this.authPayload}})
            .catch(err => logger.error(err))
    }
}

module.exports = OutgoingChannel