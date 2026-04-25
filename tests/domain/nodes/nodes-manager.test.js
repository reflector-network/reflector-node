/*eslint-disable no-undef */
/*
 * Verifies silent-peer filtering in NodesManager.getConnectedNodes() and the
 * freshness tracking that channels expose via Node.isFresh(channelType, ms).
 *
 * Silent peers (TCP-alive but no inbound message for > 30s on the relevant
 * channel) used to gate the TimestampSyncItem "all connected peers present"
 * condition; after the fix they are excluded from the connected
 * set so they no longer stall consensus.
 */

jest.mock('../../../src/domain/container', () => ({
    settingsManager: {appConfig: {publicKey: 'self-pubkey'}}
}))

jest.mock('@stellar/stellar-sdk', () => ({
    Keypair: {fromPublicKey: (pubkey) => ({pubkey})}
}))

const ChannelTypes = require('../../../src/ws-server/channels/channel-types')
const Node = require('../../../src/domain/nodes/node')
const nodesManager = require('../../../src/domain/nodes/nodes-manager')

/**
 * Minimal fake channel mirroring the real ChannelBase freshness semantics.
 * @param {Object} opts - channel configuration
 * @param {boolean} [opts.isReady] - whether the channel reports ready
 * @param {number|null} [opts.lastMessageAgoMs] - ms since last inbound message
 * @returns {Object} fake channel with isReady flag and isFresh() method
 */
function makeFakeChannel(opts = {}) {
    const {isReady = true, lastMessageAgoMs = 0} = opts
    const lastMessageAt = lastMessageAgoMs === null ? 0 : Date.now() - lastMessageAgoMs
    return {
        isReady,
        __lastMessageAt: lastMessageAt,
        isFresh(staleThresholdMs) {
            return Date.now() - this.__lastMessageAt <= staleThresholdMs
        },
        close: jest.fn()
    }
}

describe('Node.isFresh reads from the requested channel', () => {
    test('returns false when no channel is assigned for that type', () => {
        const node = new Node('peer-A')
        expect(node.isFresh(ChannelTypes.OUTGOING, 30_000)).toBe(false)
    })

    test('reflects the outgoing channel independently of the incoming channel', () => {
        const node = new Node('peer-A')
        node.assignOutgoingWebSocket(makeFakeChannel({lastMessageAgoMs: 60_000}))
        node.assignIncommingWebSocket(makeFakeChannel({lastMessageAgoMs: 1_000}))

        //Outgoing channel is stale even though the incoming channel is fresh.
        expect(node.isFresh(ChannelTypes.OUTGOING, 30_000)).toBe(false)
        expect(node.isFresh(ChannelTypes.INCOMING, 30_000)).toBe(true)
    })
})

describe('NodesManager.getConnectedNodes silent-peer filtering', () => {
    beforeEach(() => {
        //Reset the singleton between tests.
        nodesManager.__nodes.clear()
    })

    /**
     * Register a node with the given outgoing-channel state.
     * @param {string} pubkey - peer public key
     * @param {Object} [opts] - channel options forwarded to makeFakeChannel
     * @returns {Node} the registered node
     */
    function register(pubkey, opts = {}) {
        const node = new Node(pubkey)
        node.assignOutgoingWebSocket(makeFakeChannel(opts))
        nodesManager.__nodes.set(pubkey, node)
        return node
    }

    test('bug confirmation: pre-fix filter returned silent peers and gated the sync', () => {
        //Pre-fix getConnectedNodes filtered only on isReady(OUTGOING).
        //A TCP-alive but message-silent peer would therefore be returned and
        //gate TimestampSyncItem. Reconstruct the legacy filter here.
        const silent = register('peer-silent', {ready: true, lastMessageAgoMs: 60_000})
        const fresh = register('peer-fresh', {ready: true, lastMessageAgoMs: 1_000})

        const legacy = [...nodesManager.__nodes.values()]
            .filter(n => n.isReady(ChannelTypes.OUTGOING))
            .map(n => n.pubkey)

        expect(legacy).toEqual(expect.arrayContaining([silent.pubkey, fresh.pubkey]))
    })

    test('post-fix: silent peer (last message > 30s ago) is excluded', () => {
        register('peer-silent', {ready: true, lastMessageAgoMs: 60_000})
        register('peer-fresh', {ready: true, lastMessageAgoMs: 1_000})

        const connected = nodesManager.getConnectedNodes()

        expect(connected).toEqual(['peer-fresh'])
    })

    test('boundary: within 30s is fresh; past 30s is silent', () => {
        //Use margins around the 30s threshold so wall-clock drift between
        //register() and getConnectedNodes() cannot flip either peer's state.
        register('under-threshold', {ready: true, lastMessageAgoMs: 29_500})
        register('past-threshold', {ready: true, lastMessageAgoMs: 30_500})

        const connected = nodesManager.getConnectedNodes()

        expect(connected).toContain('under-threshold')
        expect(connected).not.toContain('past-threshold')
    })

    test('disconnected-and-stale peer is filtered by the isReady gate', () => {
        register('down', {ready: false, lastMessageAgoMs: 60_000})

        expect(nodesManager.getConnectedNodes()).toEqual([])
    })

    test('fresh incoming channel does NOT mask silent outgoing channel', () => {
        //This is the invariant the refactor protects: silent-peer filtering
        //must read the channel we actually send on (OUTGOING), not any
        //channel that happens to have recent traffic.
        const node = new Node('peer-X')
        node.assignOutgoingWebSocket(makeFakeChannel({ready: true, lastMessageAgoMs: 60_000}))
        node.assignIncommingWebSocket(makeFakeChannel({ready: true, lastMessageAgoMs: 100}))
        nodesManager.__nodes.set('peer-X', node)

        expect(nodesManager.getConnectedNodes()).toEqual([])
    })
})
