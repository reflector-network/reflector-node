/**
 * Message types for the websocket server
 * @readonly
 * @enum {number}
 */
const MessageTypes = {
    ERROR: -1,
    HANDSHAKE_REQUEST: 0,
    HANDSHAKE_RESPONSE: 1,
    STATE: 2,
    CONFIG: 3,
    SIGNATURE: 4,
    STATISTICS_REQUEST: 20,
    STATISTICS: 21,
    OK: 200
}

module.exports = MessageTypes