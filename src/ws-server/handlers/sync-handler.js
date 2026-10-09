const {ContractTypes} = require('@reflector/reflector-shared')
const ChannelTypes = require('../channels/channel-types')
const logger = require('../../logger')
const {getManager} = require('../../domain/subscriptions/subscriptions-data-manager')
const BaseHandler = require('./base-handler')


class SyncHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.OUTGOING, ChannelTypes.INCOMING]

    allowAnonymous = false

    handle(ws, message) {
        const syncData = message.data
        if (!syncData || typeof syncData !== 'object' || Array.isArray(syncData))
            return
        switch (syncData.type) {
            case ContractTypes.SUBSCRIPTIONS: {
                const manager = getManager(syncData.contractId)
                if (!manager) { //a peer may gossip about a contract this node does not run for a moment after a config change
                    logger.debug({msg: 'Sync data for an unknown contract ignored.', contract: syncData.contractId, node: ws.pubkey})
                    return
                }
                manager.trySetRawSyncData(syncData, ws.pubkey) //the pending sync-data quota is per sender
                break
            }
            default:
                logger.debug({msg: 'Sync type is not supported.', syncType: syncData.type})
        }
    }
}
module.exports = SyncHandler