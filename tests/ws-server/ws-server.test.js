/*eslint-disable no-undef */
jest.mock('../../src/domain/container', () => ({
    settingsManager: {appConfig: {publicKey: 'self-pubkey'}},
    handlersManager: {handle: jest.fn()}
}))

const {EventEmitter} = require('events')
const WebSocket = require('ws')
const {Keypair} = require('@stellar/stellar-sdk')
const container = require('../../src/domain/container')
const constants = require('../../src/ws-server/contstants')
const ChannelTypes = require('../../src/ws-server/channels/channel-types')
const MessageTypes = require('../../src/ws-server/handlers/message-types')
const HandshakeResponseHandler = require('../../src/ws-server/handlers/handshake-response-handler')
const nodesManager = require('../../src/domain/nodes/nodes-manager')
const Node = require('../../src/domain/nodes/node')
const WsServer = require('../../src/ws-server/index')

class FakeWs extends EventEmitter {
    constructor() {
        super()
        this.readyState = WebSocket.OPEN
        this.ping = jest.fn()
        this.send = jest.fn((_data, cb) => cb && cb())
        this.close = jest.fn(() => {
            this.readyState = WebSocket.CLOSED
        })
        this.terminate = jest.fn(() => {
            this.readyState = WebSocket.CLOSED
        })
    }
}

const peerKeypair = Keypair.random()
const PEER = peerKeypair.publicKey()

function makeRequest(pubkey, remoteAddress = '10.0.0.1') {
    return {headers: pubkey ? {pubkey} : {}, socket: {remoteAddress}}
}

function handshakeFrame(ws) {
    const frame = JSON.parse(ws.send.mock.calls[0][0])
    expect(frame.type).toBe(MessageTypes.HANDSHAKE_REQUEST)
    return frame
}

function makeValidatedChannel() {
    return {isValidated: true, isReady: true, isFresh: () => true, close: jest.fn(), send: jest.fn()}
}

describe('WsServer.__onConnect', () => {
    let server

    beforeEach(() => {
        jest.useFakeTimers()
        const handshakeHandler = new HandshakeResponseHandler()
        //eslint-disable-next-line require-await -- the wrapper must return a Promise so a synchronous throw from handle() rejects it
        container.handlersManager.handle = jest.fn(async (channel, message) => handshakeHandler.handle(channel, message))
        nodesManager.__nodes.clear()
        nodesManager.__nodes.set(PEER, new Node(PEER))
        server = new WsServer()
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    test('registers a peer whose handshake response verifies', async () => {
        const ws = new FakeWs()
        const pending = server.__onConnect(ws, makeRequest(PEER))
        const frame = handshakeFrame(ws)
        const signature = Buffer.from(peerKeypair.sign(Buffer.from(frame.data.payload))).toString('hex')
        ws.emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: frame.requestId, data: {signature}}))
        await pending

        expect(nodesManager.__nodes.get(PEER).isReady(ChannelTypes.INCOMING)).toBe(true)
        expect(ws.close).not.toHaveBeenCalled()
    })

    test('an OK frame answering the challenge does not evict the validated channel', async () => {
        const honest = makeValidatedChannel()
        nodesManager.__nodes.get(PEER).assignIncommingWebSocket(honest)
        const ws = new FakeWs()
        const pending = server.__onConnect(ws, makeRequest(PEER))
        const frame = handshakeFrame(ws)
        ws.emit('message', JSON.stringify({type: MessageTypes.OK, responseId: frame.requestId}))
        await pending

        expect(honest.close).not.toHaveBeenCalled()
        expect(nodesManager.__nodes.get(PEER).__incommingChannel).toBe(honest)
        expect(ws.close).toHaveBeenCalledWith(1008, 'Handshake failed')
    })

    test('a garbage handshake signature does not register the client', async () => {
        const honest = makeValidatedChannel()
        nodesManager.__nodes.get(PEER).assignIncommingWebSocket(honest)
        const ws = new FakeWs()
        const pending = server.__onConnect(ws, makeRequest(PEER))
        const frame = handshakeFrame(ws)
        ws.emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: frame.requestId, data: {signature: '00'}}))
        await pending

        expect(honest.close).not.toHaveBeenCalled()
        expect(nodesManager.__nodes.get(PEER).__incommingChannel).toBe(honest)
        expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid signature')
    })

    test('a client that never answers is closed at the handshake deadline', async () => {
        const honest = makeValidatedChannel()
        nodesManager.__nodes.get(PEER).assignIncommingWebSocket(honest)
        const ws = new FakeWs()
        const pending = server.__onConnect(ws, makeRequest(PEER))
        handshakeFrame(ws)

        await jest.advanceTimersByTimeAsync(constants.handshakeTimeout - 1)
        expect(ws.close).not.toHaveBeenCalled()
        await jest.advanceTimersByTimeAsync(1)
        await pending

        expect(ws.close).toHaveBeenCalledWith(1008, expect.stringContaining('Request timed out after 10000'))
        expect(honest.close).not.toHaveBeenCalled()
    })

    test('an unknown pubkey is refused before any handshake', async () => {
        const ws = new FakeWs()
        await server.__onConnect(ws, makeRequest(Keypair.random().publicKey()))

        expect(ws.send).not.toHaveBeenCalled()
        expect(ws.close).toHaveBeenCalledWith(1008, expect.stringContaining('not present in the nodes list'))
    })

    test('a refused socket is terminated one second after its close frame', async () => {
        const ws = new FakeWs()
        ws.close = jest.fn() //a client that never completes the close handshake
        await server.__onConnect(ws, makeRequest(Keypair.random().publicKey()))

        await jest.advanceTimersByTimeAsync(constants.refusedSocketGrace - 1)
        expect(ws.terminate).not.toHaveBeenCalled()
        await jest.advanceTimersByTimeAsync(1)
        expect(ws.terminate).toHaveBeenCalled()
    })
})

describe('pending handshakes are capped per cluster key, not per address', () => {
    const otherKeypair = Keypair.random()
    const OTHER = otherKeypair.publicKey()
    let server

    /**
     * @param {FakeWs} ws - socket whose challenge to answer
     * @param {Keypair} keypair - key that signs the answer
     */
    function answer(ws, keypair) {
        const frame = handshakeFrame(ws)
        const signature = Buffer.from(keypair.sign(Buffer.from(frame.data.payload))).toString('hex')
        ws.emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: frame.requestId, data: {signature}}))
    }

    beforeEach(() => {
        jest.useFakeTimers()
        const handshakeHandler = new HandshakeResponseHandler()
        //eslint-disable-next-line require-await -- the wrapper must return a Promise so a synchronous throw from handle() rejects it
        container.handlersManager.handle = jest.fn(async (channel, message) => handshakeHandler.handle(channel, message))
        nodesManager.__nodes.clear()
        nodesManager.__nodes.set(PEER, new Node(PEER))
        nodesManager.__nodes.set(OTHER, new Node(OTHER))
        server = new WsServer()
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    test('a third pending handshake under one key closes the oldest pending one', () => {
        const sockets = [new FakeWs(), new FakeWs(), new FakeWs()]
        for (const ws of sockets)
            server.__onConnect(ws, makeRequest(PEER)) //left inside the handshake window on purpose

        expect(sockets[0].close).toHaveBeenCalledWith(1008, 'Handshake superseded')
        expect(sockets[1].close).not.toHaveBeenCalled()
        expect(sockets[2].close).not.toHaveBeenCalled()
        expect(server.countPending(PEER)).toBe(constants.maxPendingPerKey)
    })

    test('an evicted handshake that answers later is not registered', async () => {
        const evicted = new FakeWs()
        const pending = server.__onConnect(evicted, makeRequest(PEER))
        server.__onConnect(new FakeWs(), makeRequest(PEER))
        server.__onConnect(new FakeWs(), makeRequest(PEER))

        answer(evicted, peerKeypair)
        await pending

        expect(nodesManager.__nodes.get(PEER).isReady(ChannelTypes.INCOMING)).toBeFalsy()
    })

    test('the real peer gets in while someone holds pending handshakes under its key', async () => {
        server.__onConnect(new FakeWs(), makeRequest(PEER, '203.0.113.9'))
        server.__onConnect(new FakeWs(), makeRequest(PEER, '203.0.113.9'))

        const real = new FakeWs()
        const pending = server.__onConnect(real, makeRequest(PEER, '10.0.0.1'))
        answer(real, peerKeypair)
        await pending

        expect(nodesManager.__nodes.get(PEER).isReady(ChannelTypes.INCOMING)).toBe(true)
        expect(real.close).not.toHaveBeenCalled()
    })

    test('pending handshakes under different keys do not evict each other', () => {
        const sockets = [new FakeWs(), new FakeWs(), new FakeWs(), new FakeWs()]
        server.__onConnect(sockets[0], makeRequest(PEER))
        server.__onConnect(sockets[1], makeRequest(PEER))
        server.__onConnect(sockets[2], makeRequest(OTHER))
        server.__onConnect(sockets[3], makeRequest(OTHER))

        for (const ws of sockets)
            expect(ws.close).not.toHaveBeenCalled()
    })

    test('connections from one address are not capped', () => {
        const sockets = [new FakeWs(), new FakeWs(), new FakeWs(), new FakeWs()]
        server.__onConnect(sockets[0], makeRequest(PEER, '10.0.0.7'))
        server.__onConnect(sockets[1], makeRequest(PEER, '10.0.0.7'))
        server.__onConnect(sockets[2], makeRequest(OTHER, '10.0.0.7'))
        server.__onConnect(sockets[3], makeRequest(OTHER, '10.0.0.7'))

        for (const ws of sockets) {
            expect(ws.send).toHaveBeenCalled() //each got its challenge
            expect(ws.close).not.toHaveBeenCalled()
        }
    })

    test('a pending handshake whose socket closes leaves the count', () => {
        const ws = new FakeWs()
        server.__onConnect(ws, makeRequest(PEER))
        expect(server.countPending(PEER)).toBe(1)

        ws.emit('close')

        expect(server.countPending(PEER)).toBe(0)
    })

    test('server options carry the payload cap and disable compression', () => {
        expect(server.__getServerOptions(31000)).toEqual({port: 31000, maxPayload: constants.maxPayload, perMessageDeflate: false})
        expect(server.__getServerOptions(undefined).port).toBe(30347)
        expect(server.__getServerOptions(0).port).toBe(0)
    })
})
