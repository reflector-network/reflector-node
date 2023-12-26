const {Server, WebSocket} = require('ws')
const {StrKey} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const container = require('../domain/container')
const nodesManager = require('../domain/nodes/nodes-manager')
const MessageTypes = require('./handlers/message-types')
const IncomingChannel = require('./channels/incoming-channel')
const OrchestratorChannel = require('./channels/orchestrator-channel')

class WsServer {
    init() {
        const {settingsManager} = container
        const {keypair, orchestratorUrl, port} = settingsManager.appConfig
        this.__keypair = keypair
        this.wsServer = new Server({port: port || 30348})
        this.wsServer
            .addListener('connection', (ws, req) => this.__onConnect(ws, req))
            .addListener('close', () => this.__onServerClose())
            .addListener('error', (err) => this.__onServerError(err))

        this.orchestratorConnection = new OrchestratorChannel(orchestratorUrl || 'ws://orchestrator.reflector.world')
    }

    /**
     * @param {WebSocket} ws - new connection
     * @param {any} req - new connection
     */
    async __onConnect(ws, req) {
        try {
            const pubkey = req.headers.pubkey
            if (!pubkey || !StrKey.isValidEd25519PublicKey(pubkey))
                throw new Error('pubkey is required')
            const incomingConnection = new IncomingChannel(ws, pubkey)
            await incomingConnection.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: incomingConnection.authPayload}})
            nodesManager.addConnection(incomingConnection)
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

    __onServerError(err) {
        logger.error('Ws server error')
        logger.error(err)
    }

    __onServerClose() {
        logger.info('Ws server closed')
    }

    close() {
        this.wsServer.close()
    }
}

module.exports = WsServer