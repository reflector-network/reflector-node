const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const MessageTypes = require('./message-types')
const BaseHandler = require('./base-handler')

class StatisticsRequestHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle(_, message) {
        return {type: MessageTypes.STATISTICS, data: container.statisticsManager.getStatistics()}
    }
}

module.exports = StatisticsRequestHandler