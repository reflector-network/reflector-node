/**
 * Message types for the websocket server
 * @readonly
 * @enum {number}
 */
const ChannelTypes = {
    OUTGOING: 1,
    INCOMING: 2,
    ORCHESTRATOR: 3
}

module.exports = ChannelTypes