const {runWithContext} = require('../../async-storage')
const logger = require('../../logger')
const ChannelTypes = require('../channels/channel-types')
const MessageTypes = require('./message-types')
const HandshakeRequestHandler = require('./handshake-request-handler')
const HandshakeResponseHandler = require('./handshake-response-handler')
const ConfigHandler = require('./config-handler')
const SignaturesHandler = require('./signatures-handler')
const StateHandler = require('./state-handler')
const StatisticsRequestHandler = require('./statistics-request-handler')
const LogsRequestHandler = require('./logs-request-handler')
const LogFileRequestHandler = require('./log-file-request-handler')
const SetTraceHandler = require('./set-trace-handler')
const SyncHandler = require('./sync-handler')
const {GatewaysGetHandler, GatewaysPostHandler} = require('./gateways-handler')
const PriceSyncHandler = require('./price-sync-handler')

/**
 * @typedef {import('../channels/channel-base')} ChannelBase
 */

class HandlersManager {

    constructor() {
        this.handlers = {
            [MessageTypes.HANDSHAKE_REQUEST]: new HandshakeRequestHandler(),
            [MessageTypes.HANDSHAKE_RESPONSE]: new HandshakeResponseHandler(),
            [MessageTypes.CONFIG]: new ConfigHandler(),
            [MessageTypes.STATE]: new StateHandler(),
            [MessageTypes.SIGNATURE]: new SignaturesHandler(),
            [MessageTypes.STATISTICS_REQUEST]: new StatisticsRequestHandler(),
            [MessageTypes.LOGS_REQUEST]: new LogsRequestHandler(),
            [MessageTypes.LOG_FILE_REQUEST]: new LogFileRequestHandler(),
            [MessageTypes.SET_TRACE]: new SetTraceHandler(),
            [MessageTypes.SYNC]: new SyncHandler(),
            [MessageTypes.GATEWAYS_GET]: new GatewaysGetHandler(),
            [MessageTypes.GATEWAYS_POST]: new GatewaysPostHandler(),
            [MessageTypes.PRICE_SYNC]: new PriceSyncHandler()
        }
    }

    /**
     * @param {ChannelBase} channel - channel type
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const handler = this.handlers[message.type]
        if (!handler)
            throw new Error(`Message type ${message.type} is not supported`)
        if (!handler.allowAnonymous && !channel.isValidated)
            throw new Error(`Message type ${message.type} is not allowed for anonymous channel`)
        if (!handler.allowedChannelTypes & channel)
            throw new Error(`Message type ${message.type} is not supported for channel ${channel}`)
        return await runWithContext(async() => {
            logger.trace({msg: 'Start handle message', msgType: MessageTypes.getName(message.type), msgChannel: ChannelTypes.getName(channel.type), msgSender: channel.pubkey})
            const data = await handler.handle(channel, message)
            logger.trace({msg: 'Finished handle message', msgType: MessageTypes.getName(message.type), msgChannel: ChannelTypes.getName(channel.type), msgSender: channel.pubkey})
            return data
        })
    }
}

module.exports = HandlersManager