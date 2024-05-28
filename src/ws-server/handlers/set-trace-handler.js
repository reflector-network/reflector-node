const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class SetTraceHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle(_, message) {
        const {data} = message
        container.settingsManager.setTrace(data.isTraceEnabled)
    }
}

module.exports = SetTraceHandler