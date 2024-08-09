const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const ChannelTypes = require('../channels/channel-types')
const logger = require('../../logger')
const {getManager} = require('../../domain/subscriptions/subscriptions-data-manager')
const BaseHandler = require('./base-handler')


class SyncHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING

    handle(ws, message) {
        const syncData = message.data
        switch (syncData.type) {
            case ContractTypes.SUBSCRIPTIONS: {
                getManager(syncData.contractId).trySetRawSyncData(syncData)
                break
            }
            default:
                logger.debug(`Sync type ${syncData.type} is not supported`)
        }
    }
}
module.exports = SyncHandler