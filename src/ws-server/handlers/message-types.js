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
    CONFIG_REQUEST: 4,
    SIGNATURE: 5,
    SYNC: 6,
    STATISTICS_REQUEST: 20,
    SET_TRACE: 22,
    LOGS_REQUEST: 23,
    LOG_FILE_REQUEST: 24,
    OK: 200
}

module.exports = MessageTypes