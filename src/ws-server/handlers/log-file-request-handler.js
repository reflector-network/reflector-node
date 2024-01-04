const fs = require('fs')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class LogFileRequestHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle(_, message) {
        const logFile = fs.readFileSync(`${container.homeDir}/logs/${message.data.logFileName}`).toString().trim()
        return {logFile}
    }
}

module.exports = LogFileRequestHandler