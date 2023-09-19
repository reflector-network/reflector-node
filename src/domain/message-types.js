/**
 * Message types for the websocket server
 * @readonly
 * @enum {number}
 */
const MessageTypes = {
    HANDSHAKE_REQUEST: 0,
    HANDSHAKE_RESPONSE: 1,
    STATE: 2,
    SETTINGS: 3,
    SIGNATURE: 4
}

module.exports = MessageTypes