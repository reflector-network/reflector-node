const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const nonceManager = require('../nonce-manager')
const BaseHandler = require('./base-handler')
const {verifyControlMessage} = require('./control-message-auth')

class SetTraceHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.ORCHESTRATOR]

    allowAnonymous = true

    handle(_, message) {
        //only this node's operator changes its tracing; a monitoring key reads other nodes' logs but does not toggle
        //them
        const {payload} = verifyControlMessage(message, nonceManager.nonceTypes.SET_TRACE, 'logs/trace', {method: 'POST', ownKeyOnly: true})
        if (typeof payload.isTraceEnabled !== 'boolean')
            throw new Error('isTraceEnabled must be a boolean')
        //the signed value; the bare copy beside the payload is there for nodes of the previous release only
        container.settingsManager.setTrace(payload.isTraceEnabled)
    }
}

module.exports = SetTraceHandler
