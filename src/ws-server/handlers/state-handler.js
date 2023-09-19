const ChannelTypes = require('../channels/channel-types')
const MessageTypes = require('../../domain/message-types')
const NodeStates = require('../../domain/nodes/node-states')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')


class StateHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING

    async handle(ws, message) {
        switch (message.data.state) {
            case NodeStates.READY: {
                const nodes = container.settingsManager.nodeAddresses
                await container.transactionsManager.broadcastSignatureTo(ws.pubkey)
                return {type: MessageTypes.SETTINGS, data: {nodes}}
            }
            default:
                throw new Error(`State ${message.data.state} is not supported`)
        }
    }
}
module.exports = StateHandler