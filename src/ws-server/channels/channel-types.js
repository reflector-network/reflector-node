/**
 * Message types for the websocket server
 * @readonly
 * @enum {number}
 */
const ChannelTypes = {
    OUTGOING: 1,
    INCOMING: 2,
    ORCHESTRATOR: 3,
    getName(type) {
        switch (type) {
            case ChannelTypes.OUTGOING:
                return 'OUTGOING'
            case ChannelTypes.INCOMING:
                return 'INCOMING'
            case ChannelTypes.ORCHESTRATOR:
                return 'ORCHESTRATOR'
            default:
                return 'UNKNOWN'
        }
    }
}

module.exports = ChannelTypes