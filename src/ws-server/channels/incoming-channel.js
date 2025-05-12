/**
 * @typedef {import('@stellar/stellar-sdk').Keypair} Keypair
 * @typedef {import('ws').WebSocket} WebSocket
 * */
const {v4: uuidv4} = require('uuid')
const ChannelBase = require('./channel-base')
const ChannelTypes = require('./channel-types')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class IncomingChannel extends ChannelBase {
    /**
     * @param {WebSocket} ws - ws instance
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

    type = ChannelTypes.INCOMING
}

module.exports = IncomingChannel