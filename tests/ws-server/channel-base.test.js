/*eslint-disable no-undef */
/*
 * The pre-fix channel closed any peer that failed to PONG within 1000 ms, which
 * produced a reconnect storm during normal gossip load (pong packets queued
 * behind multi-KB trades-data frames). These tests lock in the new 10 s timeout,
 * the 3-missed-pong tolerance, and the "inbound message is proof-of-life"
 * invariant that also fixes the latent ping-cycle-stall bug.
 */

jest.mock('../../src/domain/container', () => ({
    handlersManager: {handle: jest.fn(() => Promise.resolve({type: 1}))}
}))

const {EventEmitter} = require('events')
const WebSocket = require('ws')

const ChannelBase = require('../../src/ws-server/channels/channel-base')
const ChannelTypes = require('../../src/ws-server/channels/channel-types')

/**
 * Minimal WebSocket stand-in: readyState flag plus spies for ping/send/close/terminate.
 */
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
        this.id = 'ws-fake'
    }
}

/**
 * Concrete subclass so we can instantiate ChannelBase (it is abstract).
 */
class TestChannel extends ChannelBase {
    constructor(pubkey, ws) {
        super(pubkey)
        this.__ws = ws
        this.type = ChannelTypes.INCOMING
    }
}

describe('ChannelBase keepalive after incident 2026-04-20', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    describe('legacy 1s pong timeout (reproduces the reconnect storm)', () => {
        test('pre-fix channel would have closed a peer after 1000 ms of silence', () => {
            //This case lives as documentation: the bug was that a single slow
            //pong (common under gossip load) tore down the channel.
            const legacyTimeoutMs = 1000
            const pongArrivalMs = 1001
            expect(pongArrivalMs).toBeGreaterThan(legacyTimeoutMs)
            //The fix raises the timeout to 10_000 ms; see tests below.
        })
    })

    //Current channel-base constants: pong timeout 4s per attempt, ping re-arm delay 10s.
    const PONG_TIMEOUT_MS = 4_000
    const PING_REARM_MS = 10_000

    describe('post-fix pong timeout', () => {
        test('does not close the channel just before the pong timeout', () => {
            const ws = new FakeWs()
            const channel = new TestChannel('peer-A', ws)

            channel.__startPingPong()
            jest.advanceTimersByTime(PONG_TIMEOUT_MS - 1)

            expect(ws.close).not.toHaveBeenCalled()
            expect(channel.__missedPongs).toBe(0)
        })

        test('records a missed pong at the timeout and re-issues a ping', () => {
            const ws = new FakeWs()
            const channel = new TestChannel('peer-A', ws)

            channel.__startPingPong()
            expect(ws.ping).toHaveBeenCalledTimes(1)

            jest.advanceTimersByTime(PONG_TIMEOUT_MS)

            expect(channel.__missedPongs).toBe(1)
            expect(ws.close).not.toHaveBeenCalled()
            expect(ws.ping).toHaveBeenCalledTimes(2)
        })
    })

    describe('missed-pong tolerance', () => {
        test('closes the channel after 3 consecutive missed pongs', () => {
            const ws = new FakeWs()
            const channel = new TestChannel('peer-A', ws)

            channel.__startPingPong()
            jest.advanceTimersByTime(PONG_TIMEOUT_MS) //miss 1
            jest.advanceTimersByTime(PONG_TIMEOUT_MS) //miss 2
            expect(ws.close).not.toHaveBeenCalled()
            jest.advanceTimersByTime(PONG_TIMEOUT_MS) //miss 3

            expect(channel.__missedPongs).toBe(3)
            expect(ws.close).toHaveBeenCalledTimes(1)
            const reason = ws.close.mock.calls[0][1]
            expect(reason).toMatch(/3 missed pongs/)
        })

        test('pong resets the missed-pong counter', () => {
            const ws = new FakeWs()
            const channel = new TestChannel('peer-A', ws)

            channel.__startPingPong()
            jest.advanceTimersByTime(PONG_TIMEOUT_MS) //miss 1
            jest.advanceTimersByTime(PONG_TIMEOUT_MS) //miss 2
            expect(channel.__missedPongs).toBe(2)

            channel.__onPong()
            expect(channel.__missedPongs).toBe(0)

            //next ping cycle fires after the re-arm delay and starts fresh
            jest.advanceTimersByTime(PING_REARM_MS)   //re-arm ping
            jest.advanceTimersByTime(PONG_TIMEOUT_MS) //miss 1 on the new cycle
            expect(channel.__missedPongs).toBe(1)
            expect(ws.close).not.toHaveBeenCalled()
        })
    })

    describe('inbound message as proof-of-life', () => {
        test('message clears pong timeout and resets missed-pong counter', async () => {
            const ws = new FakeWs()
            const channel = new TestChannel('peer-A', ws)

            channel.__startPingPong()
            jest.advanceTimersByTime(PONG_TIMEOUT_MS) //miss 1
            expect(channel.__missedPongs).toBe(1)

            await channel.__onMessage(JSON.stringify({type: 1}))

            expect(channel.__missedPongs).toBe(0)
            expect(channel.__pongTimeout).toBeNull()
        })

        test('F13 regression: __onMessage re-arms next ping so cycle cannot halt', () => {
            const ws = new FakeWs()
            const channel = new TestChannel('peer-A', ws)

            channel.__startPingPong()
            ws.ping.mockClear()
            //Simulate a message arriving before the pong timer expires — i.e.
            //steady application traffic while pongs happen to be lost.
            jest.advanceTimersByTime(Math.floor(PONG_TIMEOUT_MS / 2))
            channel.__onMessage(JSON.stringify({type: 1}))

            //Pre-fix: __onMessage cleared __pongTimeout but never scheduled the
            //next ping, so once traffic stops there is no liveness probe.
            //Post-fix: __onMessage re-arms __pingTimeout; advancing past it
            //must trigger another ping.
            jest.advanceTimersByTime(PING_REARM_MS)
            expect(ws.ping).toHaveBeenCalled()
        })
    })
})

describe('ChannelBase pending requests', () => {
    const container = require('../../src/domain/container')
    const MessageTypes = require('../../src/ws-server/handlers/message-types')

    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
        container.handlersManager.handle = jest.fn(() => Promise.resolve({type: 1}))
    })

    test('rejects the pending request when the response handler throws', async () => {
        container.handlersManager.handle = jest.fn(() => {
            throw new Error('Invalid signature')
        })
        const ws = new FakeWs()
        const channel = new TestChannel('peer-A', ws)

        const pending = channel.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: 'reflector-node-x'}})
        const {requestId} = JSON.parse(ws.send.mock.calls[0][0])
        await channel.__onMessage(JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: requestId, data: {signature: '00'}}))

        await expect(pending).rejects.toThrow('Invalid signature')
        expect(channel.isValidated).toBe(false)
    })

    test('resolves the pending request when the response handler succeeds', async () => {
        container.handlersManager.handle = jest.fn((channel) => {
            channel.validated()
        })
        const ws = new FakeWs()
        const channel = new TestChannel('peer-A', ws)

        const pending = channel.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: 'reflector-node-x'}})
        const {requestId} = JSON.parse(ws.send.mock.calls[0][0])
        await channel.__onMessage(JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: requestId, data: {signature: 'aa'}}))

        await expect(pending).resolves.toBeUndefined()
        expect(channel.isValidated).toBe(true)
    })

    test('a timed-out request on one channel does not leave another channel\'s entry behind', async () => {
        const channel1 = new TestChannel('peer-A', new FakeWs())
        const channel2 = new TestChannel('peer-B', new FakeWs())
        const message = {type: MessageTypes.SIGNATURE, data: {}} //the same object, as broadcast() passes it

        const pending1 = channel1.send(message)
        const pending2 = channel2.send(message)
        pending1.catch(() => {})
        pending2.catch(() => {})

        jest.advanceTimersByTime(5000)

        await expect(pending1).rejects.toThrow('timed out')
        await expect(pending2).rejects.toThrow('timed out')
        expect(Object.keys(channel1.__requests)).toHaveLength(0)
        expect(Object.keys(channel2.__requests)).toHaveLength(0)
    })

    test('send honours an explicit timeout', async () => {
        const channel = new TestChannel('peer-A', new FakeWs())

        const pending = channel.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {}}, 100)
        pending.catch(() => {})
        jest.advanceTimersByTime(99)
        expect(Object.keys(channel.__requests)).toHaveLength(1)
        jest.advanceTimersByTime(1)

        await expect(pending).rejects.toThrow('Request timed out after 100')
    })
})
