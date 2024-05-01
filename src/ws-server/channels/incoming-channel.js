/**
 * @typedef {import('@stellar/stellar-sdk').Keypair} Keypair
 * */
const WebSocket = require('ws')
const {v4: uuidv4} = require('uuid')
const {isDebugging} = require('../../utils')
const ChannelBase = require('./channel-base')
const ChannelTypes = require('./channel-types')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class IncomingChannel extends ChannelBase {
    /**
     * @param {WebSocket.WebSocket} ws - ws instance
     * @param {string} pubkey - the pubkey of the node
     */
    constructor(ws, pubkey) {
        super(pubkey)
        if (!ws)
            throw new Error('ws is required')
        ws.id = uuidv4()
        this.__ws = ws
        this.pubkey = pubkey
        this.authPayload = uuidv4()
        this.__assignListeners()
        this.__startPingPong()
    }

    __pingTimeout

    __pongTimeout

    __assignListeners() {
        return super.__assignListeners()
            .addListener('pong', () => this.__onPong())
    }

    __onClose(code, reason) {
        this.__pingTimeout && clearTimeout(this.__pingTimeout)
        this.__pongTimeout && clearTimeout(this.__pongTimeout)
        super.__onClose(code, reason)
    }

    __onPong() {
        this.__pongTimeout && clearTimeout(this.__pongTimeout)

        this.__pingTimeout = this.__pingTimeout || setTimeout(() => {
            this.__pingTimeout = null
            this.__startPingPong()
        }, 10000)
    }

    __startPingPong() {
        if (this.__ws?.readyState !== WebSocket.OPEN) {
            super.close(1001, `Connection closed due to state ${this.__ws?.readyState}`, true)
            return
        }

        const timeout = isDebugging() ? 60 * 1000 * 60 : 1000
        this.__pongTimeout = setTimeout(() => {
            super.close(1001, `Connection closed due to inactivity after ${timeout} ${this.__getConnectionInfo()}`, true)
        }, timeout)

        this.__ws.ping()
    }

    async __onMessage(data) {
        this.__pongTimeout && clearTimeout(this.__pongTimeout)
        await super.__onMessage(data)
    }

    type = ChannelTypes.INCOMING
}

module.exports = IncomingChannel