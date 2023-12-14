const { WebSocket } = require('ws')
const container = require('../../domain/container')
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
            throw new Error('OutgoingWebSocketChannelBase is abstract class')
        if (!url)
            throw new Error('url is required')
        this.url = url
        this.__connect()
    }

    __connect() {
        const ws = new WebSocket(this.url, { headers: { 'pubkey': container.settingsManager.appConfig.publicKey } })
        this.__ws = ws
        this.__assignListeners()
        this.__ws.connectionTimeout = setTimeout(() => {
            if (ws.readyState === WebSocket.CONNECTING)
                ws.close(1001, 'Connection timeout')
        }, container.settingsManager.appConfig.handshakeTimeout)
    }

    close(code, reason, terminate = true) {
        //eslint-disable-next-line no-unused-expressions
        this.__connectionTimeoutId && clearTimeout(this.__connectionTimeoutId)
        super.close(code, reason, terminate)
    }

    get connectionAttempts() {
        return this.__connectionAttempts
    }

    __connectionAttempts = 0

    async __onOpen() {
        this.__resetConnectionAttempts()
    }

    __onClose(code, reason) {
        super.__onClose(code, reason)
        this.__incConnectionAttempts()
        if (this.__termination)
            return
        this.__connectionTimeoutId = setTimeout(() => {
            this.__connect()
        }, this.__getTimeout())
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

    __assignListeners() {
        super.__assignListeners()
        this.__ws
            .addListener('open', () => this.__onOpen())
            .addListener('ping', () => this.__ws.pong())
    }

    type = 'outgoing'
}

module.exports = OutgoingChannelBase