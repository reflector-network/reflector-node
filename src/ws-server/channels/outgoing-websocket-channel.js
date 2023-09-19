const {WebSocket} = require('ws')
const {v4: uuidv4} = require('uuid')
const container = require('../../domain/container')
const MessageTypes = require('../../domain/message-types')
const logger = require('../../logger')
const BaseWebSocketChannel = require('./base-websocket-channel')
const ChannelTypes = require('./channel-types')

/**
 * @typedef {import('soroban-client').Keypair} Keypair
 */

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class OutgoingWebSocketChannel extends BaseWebSocketChannel {
    /**
     * @param {string} pubkey - the pubkey of the node
     * @param {string} url - the url to connect to
     */
    constructor(pubkey, url) {
        super(pubkey)
        if (!url)
            throw new Error('url is required')
        this.url = url
        this.pubkey = pubkey
    }

    type = ChannelTypes.OUTGOING

    /**
     * @param {number} maxConnectionAttempts - the maximum number of connection attempts. 0 for unlimited
     * @returns {Promise<void>} - resolves when the connection is established or rejects on error
     * */
    connect(maxConnectionAttempts = 0) {
        this.__maxConnectionAttempts = maxConnectionAttempts
        this.authPayload = uuidv4()
        const ws = new WebSocket(this.url, {headers: {'pubkey': container.settingsManager.config.publicKey}})
        this.__ws = ws
        this.__assignListeners()
        this.__ws.connectionTimeout = setTimeout(() => {
            if (ws.readyState === WebSocket.CONNECTING)
                ws.close(1001, 'Connection timeout')
        }, container.settingsManager.config.handshakeTimeout)
        return new Promise((resolve, reject) => {
            this.__connectionPromise = {resolve, reject}
        })
    }

    __maxConnectionAttempts = 0

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
        //we need to send the handshake request after the connection is established
        try {
            await this.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: this.authPayload}})
            this.__resetConnectionAttempts()
            this.__connectionPromise?.resolve()
            this.__connectionPromise = null
        } catch (err) {
            logger.error(err)
            this.__connectionPromise?.reject(err)
        }
    }

    __onClose(code, reason) {
        super.__onClose(code, reason)
        this.__incConnectionAttempts()
        this.__connectionPromise?.reject(new Error('Connection closed'))
        this.__connectionPromise = null
        if (this.__termination || this.__maxConnectionAttempts !== 0 && this.__connectionAttempts >= this.__maxConnectionAttempts)
            return
        this.__connectionTimeoutId = setTimeout(() => {
            this.connect()
                .catch(() => { })
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
        this.__maxConnectionAttempts = 0 //if the connection is established, reset the max connection attempts to 0
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
}

module.exports = OutgoingWebSocketChannel