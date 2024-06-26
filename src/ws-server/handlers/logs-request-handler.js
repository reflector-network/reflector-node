const fs = require('fs')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class LogsRequestHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle() {
        const logFiles = fs.readdirSync(`${container.homeDir}/logs`)
            .filter(f => !f.endsWith('.txt'))//rotation info files
        return {logFiles, isTraceEnabled: container.settingsManager.appConfig.trace}
    }
}

module.exports = LogsRequestHandler