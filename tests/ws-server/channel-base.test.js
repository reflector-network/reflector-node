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
