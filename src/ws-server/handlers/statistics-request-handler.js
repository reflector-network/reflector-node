const statisticsManager = require('../../domain/statistics-manager')
const ChannelTypes = require('../channels/channel-types')
const BaseHandler = require('./base-handler')

class StatisticsRequestHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle() {
        return statisticsManager.getStatistics()
    }
}

module.exports = StatisticsRequestHandler