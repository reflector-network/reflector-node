const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class SettingsHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING

    async handle(_, message) {
        await container.nodesManager.addNodes(message.data.nodes)
    }
}

module.exports = SettingsHandler