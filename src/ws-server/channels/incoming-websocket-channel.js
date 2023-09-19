/**
 * @typedef {import('soroban-client').Keypair} Keypair
 * */
const WebSocket = require('ws')
const {v4: uuidv4} = require('uuid')
const BaseWebSocketChannel = require('./base-websocket-channel')
const ChannelTypes = require('./channel-types')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class IncomingWebSocketChannel extends BaseWebSocketChannel {


    /**
     * @param {WebSocket.WebSocket} ws - ws instance
     * @param {string} pubkey - the pubkey of the node
     * @param {Keypair} currentKeypair - the current keypair
     */
    constructor(ws, pubkey) {
        super(pubkey)
        if (!ws)
            throw new Error('ws is required')
        this.__ws = ws
        this.pubkey = pubkey
        this.authPayload = uuidv4()
        //trigger onOpen manually because the ws is already open and authenticated when this channel is created
        this.__assignListeners()
        this.__startPingPong()
    }

    __pingTimeout

    __pongTimeout

    __assignListeners() {
        super.__assignListeners()
        this.__ws
            .addListener('ping', () => this.__onPing())
            .addListener('pong', () => this.__onPong())
    }

    __onClose(code, reason) {
        super.__onClose(code, reason)
        clearTimeout(this.__pingTimeout)
        clearTimeout(this.__pongTimeout)
    }

    __onPing() {
        this._ws.pong()
    }

    __onPong() {
        clearTimeout(this.__pongTimeout)
    }

    __startPingPong() {
        if (this.__ws?.readyState !== WebSocket.OPEN) {
            super.close(1001, 'Connection closed due to inactivity', true)
            return
        }
        this.__ws.ping()

        this.__pongTimeout = setTimeout(() => {
            super.close(1001, 'Connection closed due to inactivity', true)
        }, 500)

        this.pingTimeout = setTimeout(() => {
            this.__startPingPong()
        }, 1000)
    }

    type = ChannelTypes.INCOMING
}

module.exports = IncomingWebSocketChannel