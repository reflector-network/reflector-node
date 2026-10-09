const {Server, WebSocket} = require('ws')
const {StrKey} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const container = require('../domain/container')
const nodesManager = require('../domain/nodes/nodes-manager')
const constants = require('./contstants')
const MessageTypes = require('./handlers/message-types')
const IncomingChannel = require('./channels/incoming-channel')
const OrchestratorChannel = require('./channels/orchestrator-channel')

//ws rejects close reasons longer than 123 bytes
function truncateReason(reason) {
    return Buffer.byteLength(reason) > 123 ? Buffer.from(reason).subarray(0, 123).toString() : reason
}

class WsServer {

    /**
     * Unanswered handshakes per claimed cluster key, oldest first. Caps are per key, never per address: peers can share
     * an address (a NAT, a proxy), and an address says nothing about who is connecting. A key is public, so anyone can
     * claim one; a newer handshake under a key closes its oldest pending one, so the real peer always gets a slot and
     * answers its challenge within a round trip, and the handshakes held stay bounded at maxPendingPerKey x node count.
     * Keys outside the cluster never get this far.
     * @type {Map<string, {ws: WebSocket, evicted: boolean}[]>}
     */
    __pending = new Map()

    /**
     * @param {string} pubkey - claimed cluster key
     * @returns {number} handshakes pending under the key
     */
    countPending(pubkey) {
        return this.__pending.get(pubkey)?.length || 0
    }

    /**
     * @param {string} pubkey - claimed cluster key
     * @param {WebSocket} ws - new connection
     * @returns {{ws: WebSocket, evicted: boolean}} the entry, removed again once the handshake ends or the socket closes
     */
    __addPending(pubkey, ws) {
        const entry = {ws, evicted: false}
        const pending = this.__pending.get(pubkey) || []
        pending.push(entry)
        this.__pending.set(pubkey, pending)
        while (pending.length > constants.maxPendingPerKey) {
            const oldest = pending.shift()
            oldest.evicted = true
            this.__closeUnauthorized(oldest.ws, 'Handshake superseded')
        }
        ws.once('close', () => this.__removePending(pubkey, entry))
        return entry
    }

    /**
     * @param {string} pubkey - claimed cluster key
     * @param {{ws: WebSocket, evicted: boolean}} entry - pending handshake
     */
    __removePending(pubkey, entry) {
        const pending = this.__pending.get(pubkey)
        if (!pending)
            return
        const index = pending.indexOf(entry)
        if (index >= 0)
            pending.splice(index, 1)
        if (!pending.length)
            this.__pending.delete(pubkey)
    }

    init() {
        const {settingsManager} = container
        const {keypair, orchestratorUrl, port} = settingsManager.appConfig
        this.__keypair = keypair
        this.wsServer = new Server(this.__getServerOptions(port))
        this.wsServer
            .addListener('connection', (ws, req) => this.__onConnect(ws, req))
            .addListener('close', () => this.__onServerClose())
            .addListener('error', (err) => this.__onServerError(err))

        this.orchestratorConnection = new OrchestratorChannel(orchestratorUrl || 'https://orchestrator.reflector.network')
    }

    /**
     * @param {number} port - configured port; 30347 when not a number
     * @returns {{port: number, maxPayload: number, perMessageDeflate: boolean}}
     */
    //eslint-disable-next-line class-methods-use-this
    __getServerOptions(port) {
        const parsedPort = parseInt(port, 10)
        return {
            port: Number.isNaN(parsedPort) ? 30347 : parsedPort,
            maxPayload: constants.maxPayload,
            perMessageDeflate: false
        }
    }

    /**
     * Registers a peer only after its handshake response verified. Unknown keys are closed before any challenge; failed,
     * slow and superseded handshakes are closed without touching the existing channel for that peer.
     * @param {WebSocket} ws - new connection
     * @param {any} req - upgrade request
     */
    async __onConnect(ws, req) {
        const remoteAddress = req.socket?.remoteAddress || 'unknown'
        let pending = null
        let pubkey = null
        try {
            pubkey = req.headers.pubkey
            if (!pubkey || !StrKey.isValidEd25519PublicKey(pubkey) || !nodesManager.hasNode(pubkey))
                throw new Error('pubkey is undefined or invalid, or not present in the nodes list')
            pending = this.__addPending(pubkey, ws)
            const incomingConnection = new IncomingChannel(ws, pubkey)
            await incomingConnection.send(
                {type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: incomingConnection.authPayload}},
                constants.handshakeTimeout
            )
            //a newer handshake under the same key closed this one; its answer, however valid, comes too late
            if (pending.evicted)
                throw new Error('Handshake superseded')
            if (!incomingConnection.isValidated)
                throw new Error('Handshake failed')
            nodesManager.addConnection(incomingConnection)
        } catch (err) {
            logger.debug({msg: 'Error occurred while connecting', remoteAddress, err: err.message})
            if (!pending?.evicted) //an evicted socket is being closed already
                this.__closeUnauthorized(ws, err.message)
        } finally {
            if (pending)
                this.__removePending(pubkey, pending)
        }
    }

    //eslint-disable-next-line class-methods-use-this
    __closeUnauthorized(ws, reason) {
        ws.closeTimeout = setTimeout(() => {
            if (ws.readyState !== WebSocket.CLOSED) {
                logger.debug('Connection not closed in time, forcefully closing')
                ws.terminate()
            }
        }, constants.refusedSocketGrace)
        ws.once('close', () => clearTimeout(ws.closeTimeout))
        ws.close(1008, truncateReason(reason))
    }

    __onServerError(err) {
        //an error before the server listens means its port could not be bound (EACCES below 1024 for the image's
        //unprivileged user, EADDRINUSE when the port is taken). A node that kept running would look healthy while no
        //peer can reach it, so it stops and the process manager starts it again
        if (!this.wsServer?.address()) {
            logger.error({msg: 'Ws server cannot listen on its port; stopping the node', err: err.message})
            //some timeout to write logs
            setTimeout(() => process.exit(13), 3000)
            return
        }
        logger.error({msg: 'Ws server error', err: err.message})
    }

    __onServerClose() {
        logger.info('Ws server closed')
    }

    close() {
        this.wsServer?.close()
    }
}

module.exports = WsServer
