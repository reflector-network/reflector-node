const ChannelTypes = require('../channels/channel-types')
const logger = require('../../logger')
const BaseHandler = require('./base-handler')

class SetTraceHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle(_, message) {
        const {data} = message
        logger.setTrace(data.isTraceEnabled)
    }
}

module.exports = SetTraceHandler