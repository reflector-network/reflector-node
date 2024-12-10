const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')


class PriceSyncHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING

    handle(ws, message) {
        container.tradesManager.addPendingTradesData(ws.pubkey, message.data)
    }
}
module.exports = PriceSyncHandler