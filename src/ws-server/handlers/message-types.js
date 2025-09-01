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
    PRICE_SYNC: 7,
    STATISTICS_REQUEST: 20,
    SET_TRACE: 22,
    LOGS_REQUEST: 23,
    LOG_FILE_REQUEST: 24,
    GATEWAYS_GET: 25,
    GATEWAYS_POST: 26,
    OK: 200,
    getName(type) {
        switch (type) {
            case MessageTypes.ERROR:
                return 'ERROR'
            case MessageTypes.HANDSHAKE_REQUEST:
                return 'HANDSHAKE_REQUEST'
            case MessageTypes.HANDSHAKE_RESPONSE:
                return 'HANDSHAKE_RESPONSE'
            case MessageTypes.STATE:
                return 'STATE'
            case MessageTypes.CONFIG:
                return 'CONFIG'
            case MessageTypes.CONFIG_REQUEST:
                return 'CONFIG_REQUEST'
            case MessageTypes.SIGNATURE:
                return 'SIGNATURE'
            case MessageTypes.SYNC:
                return 'SYNC'
            case MessageTypes.PRICE_SYNC:
                return 'PRICE_SYNC'
            case MessageTypes.STATISTICS_REQUEST:
                return 'STATISTICS_REQUEST'
            case MessageTypes.SET_TRACE:
                return 'SET_TRACE'
            case MessageTypes.LOGS_REQUEST:
                return 'LOGS_REQUEST'
            case MessageTypes.LOG_FILE_REQUEST:
                return 'LOG_FILE_REQUEST'
            case MessageTypes.GATEWAYS_GET:
                return 'GATEWAYS_GET'
            case MessageTypes.GATEWAYS_POST:
                return 'GATEWAYS_POST'
            case MessageTypes.OK:
                return 'OK'
            default:
                return 'UNKNOWN'
        }
    }
}

module.exports = MessageTypes