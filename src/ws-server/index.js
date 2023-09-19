const EventEmitter = require('events')
const {Server, WebSocket} = require('ws')
const {StrKey} = require('soroban-client')
const logger = require('../logger')
const MessageTypes = require('../domain/message-types')
const container = require('../domain/container')
const {normalizePort} = require('../utils/port-helper')
const IncomingWebSocketChannel = require('./channels/incoming-websocket-channel')
const OutgoingWebSocketChannel = require('./channels/outgoing-websocket-channel')

/**
 * @typedef {import('../config')} Config
 */

class WsServer extends EventEmitter {

    static EVENTS = {
        CONNECTION: 'connection'
    }

    start() {
        if (this.wsServer)
            return
        this.__port = normalizePort(process.env.WS_PORT || 30348)
        this.__keypair = container.settingsManager.config.keypair
        this.wsServer = new Server({port: this.__port})
        this.wsServer
            .addListener('listening', () => this.__onServerListening())
            .addListener('connection', (ws, req) => this.__onConnect(ws, req))
            .addListener('close', () => this.__onServerClose())
            .addListener('error', (err) => this.__onServerError(err))
    }


    getNewConnection(url, pubkey) {
        if (!url)
            throw new Error('url is required')
        if (!pubkey)
            throw new Error('pubkey is required')
        return new OutgoingWebSocketChannel(pubkey, url, this.__keypair)
    }

    shutdown(terminate = true) {
        this.__termination = terminate
        this.wsServer?.close()
    }

    /**
     * @param {WebSocket} ws - new connection
     * @param {any} req - new connection
     */
    async __onConnect(ws, req) {
        try {
            if (!container.nodesManager.isRunning)
                throw new Error('Node is not ready')
            const pubkey = req.headers.pubkey
            if (!pubkey || !StrKey.isValidEd25519PublicKey(pubkey))
                throw new Error('pubkey is required')
            const incomingConnection = new IncomingWebSocketChannel(ws, pubkey)
            await incomingConnection.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: incomingConnection.authPayload}})
            this.emit(WsServer.EVENTS.CONNECTION, incomingConnection)
        } catch (err) {
            logger.debug(err)
            ws.closeTimeout = setTimeout(() => {
                if (ws.readyState !== WebSocket.CLOSED) {
                    logger.debug('Connection not closed in time, forcefully closing')
                    ws.terminate()
                }
            }, 5000)
            ws.once('close', () => {
                clearTimeout(ws.closeTimeout)
                ws.terminate()
            })
            ws.close(1000, 'Unauthorized')
        }
    }

    __onServerClose() {
        if (this.wsServer) {
            this.wsServer.removeAllListeners()
            this.wsServer = null
        }
        if (!this.__termination)
            this.start()
    }

    __onServerError(err) {
        logger.error('Ws server error')
        logger.error(err)
    }

    __onServerListening() {
        logger.info('WebSocket server listening on ' + this.__port)
    }
}

module.exports = WsServer