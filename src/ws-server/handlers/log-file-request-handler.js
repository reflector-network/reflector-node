const fs = require('fs')
const path = require('path')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class LogFileRequestHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.ORCHESTRATOR]

    allowAnonymous = true

    handle(_, message) {
        const logFile = fs.readFileSync(`${container.homeDir}/logs/${path.basename(message.data.logFileName)}`).toString().trim()
        return {logFile}
    }
}

module.exports = LogFileRequestHandler