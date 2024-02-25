const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class StatisticsRequestHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle() {
        return container.statisticsManager.getStatistics()
    }
}

module.exports = StatisticsRequestHandler