const fs = require('fs')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const nonceManager = require('../nonce-manager')
const BaseHandler = require('./base-handler')
const {verifyControlMessage} = require('./control-message-auth')

class LogsRequestHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.ORCHESTRATOR]

    allowAnonymous = true

    handle(_, message) {
        verifyControlMessage(message, nonceManager.nonceTypes.LOGS, 'logs', {method: 'GET'})
        const logFiles = fs.readdirSync(`${container.homeDir}/logs`)
            .filter(f => !f.endsWith('.txt'))//rotation info files
        return {logFiles, isTraceEnabled: container.settingsManager.appConfig.trace}
    }
}

module.exports = LogsRequestHandler
