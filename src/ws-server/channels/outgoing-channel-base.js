const {WebSocket} = require('ws')
const {v4: uuidv4} = require('uuid')
const container = require('../../domain/container')
const logger = require('../../logger')
const ChannelBase = require('./channel-base')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class OutgoingChannelBase extends ChannelBase {
    /**
     * @param {string} pubkey - the pubkey of the node
     * @param {string} url - the url to connect to
     */
    constructor(pubkey, url) {
        super(pubkey)
        if (this.constructor === OutgoingChannelBase)
            throw new Error('OutgoingChannelBase is abstract class')
        if (!url)
            throw new Error('url is required')
        this.url = url
        this.__connect()
    }

    get headers() {
        return {}
    }

    __connect() {
        this.__ws = new WebSocket(this.url,
            {
                headers: {'pubkey': container.settingsManager.appConfig.publicKey, ...this.headers}
            })
        //start ping pong, if it's not connected in time, the connection will be closed
        this.__connectionTimeout = setTimeout(() => {
            logger.trace(`Connection timeout ${this.__getConnectionInfo()}. ws.readyState: ${this.__ws?.readyState}`)
            this.__startPingPong()
        }, container.settingsManager.appConfig.handshakeTimeout)
        this.__ws.id = uuidv4()
        this.__assignListeners()
    }

    close(code, reason, terminate = true) {
        //eslint-disable-next-line no-unused-expressions
        logger.trace(`Close ${this.__getConnectionInfo()} ${code} ${reason}, terminate: ${terminate}`)
        this.__clearTimeouts()
        super.close(code, reason, terminate)
    }

    get connectionAttempts() {
        return this.__connectionAttempts
    }

    __connectionAttempts = 0

    __assignListeners() {
        return super.__assignListeners()
            .addListener('open', () => this.__onOpen())
    }

    __onOpen() {
        logger.trace(`Connection open ${this.__getConnectionInfo()}`)
        this.__clearReconnectionTimeout()
        this.__resetConnectionAttempts()
    }

    __onClose(code, reason) {
        this.__clearTimeouts()
        super.__onClose(code, reason)
        this.__incConnectionAttempts()
        if (this.__termination) {
            logger.trace(`Termination ${this.__getConnectionInfo()}`)
            return
        }
        const timeout = this.__getTimeout()
        this.__reconnectionTimeoutId = this.__reconnectionTimeoutId || setTimeout(() => {
            logger.trace(`Reconnection ${this.__getConnectionInfo()}`)
            this.__connect()
        }, timeout)
        logger.trace(`Reconnection timeout set ${timeout}. ${this.__getConnectionInfo()}`)
    }

    __onError(error) {
        error.connectionAttempts = this.__connectionAttempts
        super.__onError(error)
    }

    __incConnectionAttempts() {
        if (Number.MAX_VALUE > this.__connectionAttempts)
            this.__connectionAttempts++
    }

    __resetConnectionAttempts() {
        if (this.__connectionAttempts > 0)
            this.__connectionAttempts = 0
    }

    __getTimeout() {
        const timeout = Math.pow(2, Math.min(5, this.__connectionAttempts)) * 1000
        return timeout
    }

    __clearTimeouts() {
        this.__clearReconnectionTimeout()
        this.__clearConnectionTimeout()
    }

    __clearReconnectionTimeout() {
        this.__reconnectionTimeoutId && clearTimeout(this.__reconnectionTimeoutId)
        this.__reconnectionTimeoutId = null
    }

    __clearConnectionTimeout() {
        this.__connectionTimeout && clearTimeout(this.__connectionTimeout)
        this.__connectionTimeout = null
    }

    type = 'outgoing'
}

module.exports = OutgoingChannelBase