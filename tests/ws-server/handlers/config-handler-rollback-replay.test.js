/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')
const {Config} = require('@reflector/reflector-shared')

//Every node is a process of its own: the real SettingsManager, nonce-manager, ConfigHandler and ClusterRunner in an
//isolated module graph over a temporary home, so its floors live in its .nonce.json and a restart reloads them. The
//orchestrator is modelled by the CONFIG messages it sends: the current envelope, and the pending one while it is open
const kps = Array.from({length: 6}, () => Keypair.random())
const systemAccount = Keypair.random().publicKey()
const minute = 60_000
const T0 = 1_800_000_000_000 //P's first signature
const T = T0 + 4 * minute //P's switch time
const T2 = T + 30 * minute //Q's switch time
const T3 = T2 + 20 * minute //the switch time a replayed rollback carries
const five = [0, 1, 2, 3, 4]
const six = [0, 1, 2, 3, 4, 5]
const supersededMsg = 'Config envelope is superseded: every counted signature predates the stored nonce'
const noFreshMajorityMsg = 'Config envelope is superseded: fewer than a majority of the current node set signed after the config this node adopted'

let now = T0
jest.spyOn(Date, 'now').mockImplementation(() => now)

/**
 * @param {number[]} set - indexes of the node keys
 * @param {object} [overrides] - fields merged over the defaults
 * @returns {object} raw cluster config
 */
function rawConfig(set, overrides = {}) {
    const nodes = {}
    set.forEach(i => {
        nodes[kps[i].publicKey()] = {pubkey: kps[i].publicKey(), url: `ws://127.0.0.1:30${10 + i}`, domain: `node${i}.example.com`}
    })
    return {contracts: {}, nodes, wasmHash: {oracle: 'a'.repeat(64)}, minDate: 0, systemAccount, network: 'testnet', decimals: 14, ...overrides}
}

/**
 * @param {object} raw - raw config
 * @param {number} i - index of the signer
 * @param {number} nonce - signature nonce, the signer's signing time
 * @returns {object} raw signature entry
 */
function sign(raw, i, nonce) {
    const hash = new Config(raw).getSignaturePayloadHash(kps[i].publicKey(), nonce, false)
    return {pubkey: kps[i].publicKey(), nonce, signature: Buffer.from(kps[i].sign(Buffer.from(hash, 'hex'))).toString('hex')}
}

const envelope = (config, signatures, timestamp) => ({config, signatures, timestamp, allowEarlySubmission: false})
const withoutSigner = (signatures, i) => signatures.filter(s => s.pubkey !== kps[i].publicKey())
const hashOf = raw => new Config(raw).getHash()

const homes = []

/**
 * @param {object} [current] - raw config stored as the node's current config
 * @returns {string} a new node home
 */
function newHome(current) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-rollback-replay-'))
    homes.push(home)
    if (current)
        fs.writeFileSync(path.join(home, '.config.json'), JSON.stringify(new Config(current).toPlainObject()))
    return home
}

/**
 * Starts a node process over its home, or restarts one: nothing but the files in the home carries over
 * @param {string} home - node home
 * @param {number} index - index of the node key
 * @param {string} [clusterConfigHash] - the operator's pin in app.config.json
 * @returns {Promise<object>} the node
 */
async function startNode(home, index, clusterConfigHash) {
    const container = {homeDir: home, settingsManager: null, tradesManager: {setNodes: () => {}}}
    let modules = null
    jest.isolateModules(() => {
        jest.doMock('../../../src/domain/container', () => container)
        jest.doMock('../../../src/domain/runners/runner-manager', () => ({setContracts: () => {}, start: () => {}}))
        jest.doMock('../../../src/domain/nodes/nodes-manager', () => ({setNodes: () => {}, broadcast: () => {}, sendTo: () => {}}))
        jest.doMock('../../../src/domain/statistics-manager', () => ({setContractIds: () => {}, setLastProcessedTimestamp: () => {}}))
        jest.doMock('../../../src/domain/data-sources-manager', () => ({
            setDataSources: () => {},
            setGateways: () => {},
            get: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc.invalid']})
        }))
        jest.doMock('../../../src/utils', () => ({
            ...jest.requireActual('../../../src/utils'),
            getAccount: () => Promise.resolve({accountId: () => systemAccount, sequenceNumber: () => '1'})
        }))
        modules = {
            SettingsManager: require('../../../src/domain/settings-manager'),
            ConfigHandler: require('../../../src/ws-server/handlers/config-handler'),
            ClusterRunner: require('../../../src/domain/runners/cluster-runner'),
            logger: require('../../../src/logger')
        }
    })
    const appConfigPath = path.join(home, 'app.config.json')
    if (!fs.existsSync(appConfigPath))
        fs.writeFileSync(appConfigPath, JSON.stringify({
            secret: kps[index].secret(),
            dataSources: {exchanges: {type: 'api', name: 'exchanges', providers: ['binance']}},
            ...(clusterConfigHash ? {clusterConfigHash} : {})
        }))
    const settings = new modules.SettingsManager()
    await settings.init()
    container.settingsManager = settings
    const runner = new modules.ClusterRunner()
    return {
        index,
        home,
        settings,
        logger: modules.logger,
        /**
         * @param {object} currentConfig - current config envelope
         * @param {object} [pendingConfig] - pending config envelope
         */
        async receive(currentConfig, pendingConfig) {
            await new modules.ConfigHandler().handle({}, {data: {currentConfig, pendingConfig}})
        },
        /**
         * One cluster round at the tick
         * @param {number} tick - sync timestamp
         * @param {boolean} [lands] - whether the round's transaction lands
         * @returns {Promise<number>} how many transactions the round built
         */
        async round(tick, lands = true) {
            let built = 0
            runner.__buildAndSubmitTransaction = () => {
                built++
                if (!lands)
                    return Promise.reject(new Error('Failed to submit transaction'))
                return Promise.resolve({response: {}, tx: {}})
            }
            try {
                await runner.__workerFn(tick)
            } catch (err) {
                if (lands)
                    throw err
            }
            return built
        },
        get hash() {
            return settings.config?.getHash() || null
        },
        get pendingHash() {
            return settings.pendingConfig?.config.getHash() || null
        },
        /**
         * @returns {Object.<string, number>} the nonces stored in the home
         */
        nonces() {
            return JSON.parse(fs.readFileSync(path.join(home, '.nonce.json'), 'utf8'))
        },
        /**
         * @param {string} msg - logged message
         * @returns {object[]} the error entries logged with it
         */
        errorsWith(msg) {
            return modules.logger.error.mock.calls.map(([entry]) => entry).filter(entry => entry?.msg === msg)
        }
    }
}

afterAll(() => {
    for (const home of homes)
        fs.rmSync(home, {recursive: true, force: true})
})

//O is the config the cluster ran before P; P, a config-only change, is applied by 3 of 5 at T; Q upgrades P's WASM
const O = rawConfig(five, {decimals: 14})
const oSignatures = five.map(i => sign(O, i, T0 - 60 * minute))
const P = rawConfig(five, {decimals: 16})
const pSignatures = [0, 1, 2].map(i => sign(P, i, T0 + i * 1000))
const Q = rawConfig(five, {decimals: 16, wasmHash: {oracle: 'b'.repeat(64)}})

/**
 * Five nodes that ran O, scheduled P, applied it through the cluster runner at T, and got its echo
 * @returns {Promise<object[]>} the nodes, by key index
 */
async function clusterOnP() {
    now = T0 + 3 * minute
    const nodes = []
    for (const i of five) {
        const node = await startNode(newHome(O), i)
        await node.receive(envelope(O, oSignatures, T0 - 70 * minute), {...envelope(P, pSignatures, T), expirationDate: T0 + 60 * minute})
        nodes.push(node)
    }
    now = T + 5
    for (const node of nodes)
        expect(await node.round(T)).toBe(1)
    now = T + 30_000
    for (const node of nodes)
        await node.receive(envelope(P, pSignatures, T))
    expect(nodes.map(node => node.hash === hashOf(P))).toEqual([true, true, true, true, true])
    expect(nodes.map(node => node.nonces().configFloor)).toEqual([T0, T0, T0, T0, T0])
    return nodes
}

/**
 * Q's votes and operators 3 and 4 topping P up, in the order of a timing a review found
 * @param {string} timing - 'between' Q's first and last signature, 'after' Q was fully signed, or 'before' Q (RN 13)
 * @returns {{qSignatures: object[], pToppedUp: object[]}}
 */
function signQ(timing) {
    const topUps = at => [sign(P, 3, at), sign(P, 4, at + 1000)]
    if (timing === 'between')
        return {
            qSignatures: [sign(Q, 0, T + 5 * minute), sign(Q, 1, T + 11 * minute), sign(Q, 2, T + 11 * minute + 1000)],
            pToppedUp: [...pSignatures, ...topUps(T + 10 * minute)]
        }
    const qSignatures = [0, 1, 2].map(i => sign(Q, i, T + 5 * minute + i * 1000))
    return {qSignatures, pToppedUp: [...pSignatures, ...topUps(timing === 'after' ? T + 10 * minute : T + 2 * minute)]}
}

describe('an older config replayed as a pending update after the next one landed', () => {
    //the refusal every node logs, by key index: n1 and n2 voted on Q after the top-up (S2a), so their own vote already
    //refuses P; everywhere else only two counted signatures at most - the top-ups - follow Q's earliest counted one
    const refusals = {
        between: [['fresh', 2], ['own vote'], ['own vote'], ['fresh', 1], ['fresh', 1]],
        after: [['fresh', 2], ['fresh', 2], ['fresh', 2], ['fresh', 1], ['fresh', 1]],
        before: [['own vote'], ['own vote'], ['own vote'], ['own vote'], ['own vote']]
    }

    test.each([
        ['between', false],
        ['between', true],
        ['after', false],
        ['after', true],
        ['before', false],
        ['before', true]
    ])('top-ups %s Q\'s signatures, restart %s: no node schedules or builds the rollback', async (timing, restart) => {
        let nodes = await clusterOnP()
        const {qSignatures, pToppedUp} = signQ(timing)
        //honest: every node schedules Q, applies it at its switch time and keeps it after its echo
        now = T + 12 * minute
        for (const node of nodes)
            await node.receive(envelope(P, pToppedUp, T), {...envelope(Q, qSignatures, T2), expirationDate: T2 + 30 * minute})
        expect(nodes.map(node => node.pendingHash === hashOf(Q))).toEqual([true, true, true, true, true])
        now = T2 + 5
        for (const node of nodes)
            expect(await node.round(T2)).toBe(1)
        now = T2 + 30_000
        for (const node of nodes)
            await node.receive(envelope(Q, qSignatures, T2))
        expect(nodes.map(node => node.hash === hashOf(Q))).toEqual([true, true, true, true, true])
        //the CONFIG floor is Q's earliest counted signature on every node
        expect(nodes.map(node => node.nonces().configFloor)).toEqual(Array(5).fill(T + 5 * minute))
        if (restart) {
            now = T2 + 5 * minute
            const restarted = []
            for (const node of nodes)
                restarted.push(await startNode(node.home, node.index))
            nodes = restarted
            expect(nodes.map(node => node.hash === hashOf(Q))).toEqual([true, true, true, true, true])
        }

        //the orchestrator channel replays P, topped up, as the pending update, leaving out each recipient's own signature
        now = T2 + 10 * minute
        for (const node of nodes) {
            const replayed = envelope(P, withoutSigner(pToppedUp, node.index), T3)
            await node.receive(envelope(Q, qSignatures, T2), {...replayed, expirationDate: T3 + 30 * minute})
        }

        expect(nodes.map(node => node.pendingHash)).toEqual([null, null, null, null, null])
        nodes.forEach((node, i) => {
            const [reason, fresh] = refusals[timing][i]
            if (reason === 'fresh') {
                expect(node.errorsWith(noFreshMajorityMsg)).toEqual([{
                    msg: noFreshMajorityMsg,
                    nonceType: 'pendingConfig',
                    fresh,
                    required: 3,
                    configFloor: T + 5 * minute
                }])
            } else {
                expect(node.errorsWith(supersededMsg)).toEqual([expect.objectContaining({nonceType: 'pendingConfig'})])
                expect(node.errorsWith(noFreshMajorityMsg)).toEqual([])
            }
        })
        now = T3 + 5
        const built = []
        for (const node of nodes)
            built.push(await node.round(T3))
        expect(built).toEqual([0, 0, 0, 0, 0])
        expect(nodes.map(node => node.hash === hashOf(Q))).toEqual([true, true, true, true, true])
    })
})

describe('an older config replayed as the current config to a node that adopted the next one from its echo', () => {
    /**
     * Runs the cluster on P, lets Q land through the others while `self` is offline across Q's switch time, has `self`
     * adopt Q from the echo, then replays P's echo to it
     * @param {number} self - index of the node that adopts Q from the echo
     * @param {object[]} qSignatures - Q's counted votes
     * @param {object[]} pToppedUp - P's signatures with the top-ups
     * @param {boolean} restart - whether the node restarts before the replay
     * @returns {Promise<object>} the node after the replay
     */
    async function replayToEchoAdopter(self, qSignatures, pToppedUp, restart) {
        const nodes = await clusterOnP()
        let node = nodes[self]
        now = T + 12 * minute
        await node.receive(envelope(P, pToppedUp, T), {...envelope(Q, qSignatures, T2), expirationDate: T2 + 30 * minute})
        expect(node.pendingHash).toBe(hashOf(Q))
        //offline across T2; back to the echo of Q, which the rest of the cluster applied
        now = T2 + 10 * minute
        await node.receive(envelope(Q, qSignatures, T2))
        expect(node.hash).toBe(hashOf(Q))
        expect(node.pendingHash).toBeNull()
        if (restart)
            node = await startNode(node.home, self)
        now = T2 + 20 * minute
        await node.receive(envelope(P, pToppedUp, T))
        return node
    }

    test.each([false, true])('n3 signed Q last, after n4 topped P up (S3b); restart %s: n3 stays on Q', async restart => {
        const qSignatures = [sign(Q, 0, T + 5 * minute), sign(Q, 1, T + 5 * minute + 1000), sign(Q, 3, T + 11 * minute)]
        const pToppedUp = [...pSignatures, sign(P, 4, T + 10 * minute)]

        const node = await replayToEchoAdopter(3, qSignatures, pToppedUp, restart)

        expect(node.hash).toBe(hashOf(Q))
        //the CONFIG nonce is Q's lowest counted nonce, below n4's top-up: only the majority rule refuses P
        expect(node.nonces().config).toBe(T + 5 * minute)
        expect(node.errorsWith(noFreshMajorityMsg)).toEqual([{
            msg: noFreshMajorityMsg,
            nonceType: 'config',
            fresh: 1,
            required: 3,
            configFloor: T + 5 * minute
        }])
    })

    test.each([false, true])('n3 did not sign Q (S3c); restart %s: n3 stays on Q', async restart => {
        const qSignatures = [0, 1, 2].map(i => sign(Q, i, T + 5 * minute + i * 1000))
        const pToppedUp = [...pSignatures, sign(P, 4, T + 10 * minute)]

        const node = await replayToEchoAdopter(3, qSignatures, pToppedUp, restart)

        expect(node.hash).toBe(hashOf(Q))
        expect(node.nonces().config).toBeUndefined() //n3 voted on neither P nor Q
        expect(node.errorsWith(noFreshMajorityMsg)).toEqual([{
            msg: noFreshMajorityMsg,
            nonceType: 'config',
            fresh: 1,
            required: 3,
            configFloor: T + 5 * minute
        }])
    })

    test.each([false, true])('n0 voted on P, not on Q, and its own P vote is replayed with two top-ups; restart %s: n0 stays on Q', async restart => {
        //n0's CONFIG nonce is its own vote on P, which it stored when P landed: that same vote is no new vote and does
        //not count toward the majority, although it passes the own-signature guard
        const qSignatures = [1, 2, 3].map(i => sign(Q, i, T + 5 * minute + i * 1000))
        const pToppedUp = [...pSignatures, sign(P, 3, T + 10 * minute), sign(P, 4, T + 10 * minute + 1000)]

        const node = await replayToEchoAdopter(0, qSignatures, pToppedUp, restart)

        expect(node.hash).toBe(hashOf(Q))
        expect(node.nonces().config).toBe(T0)
        expect(node.errorsWith(noFreshMajorityMsg)).toEqual([{
            msg: noFreshMajorityMsg,
            nonceType: 'config',
            fresh: 2,
            required: 3,
            configFloor: T + 5 * minute + 1000
        }])
    })
})

describe('honest updates are still accepted with the floors in place', () => {
    /**
     * The next proposal after P, scheduled and applied by the given nodes
     * @param {object[]} nodes - nodes running P
     * @param {object} currentEcho - the orchestrator's echo of P
     * @param {object} next - raw next config
     * @param {object[]} signatures - its votes
     */
    async function scheduleAndApply(nodes, currentEcho, next, signatures) {
        const switchTime = now + 10 * minute
        for (const node of nodes) {
            await node.receive(currentEcho, {...envelope(next, signatures, switchTime), expirationDate: switchTime + 30 * minute})
            expect(node.errorsWith(noFreshMajorityMsg)).toEqual([])
        }
        expect(nodes.map(node => node.pendingHash === hashOf(next))).toEqual(nodes.map(() => true))
        now = switchTime + 5
        for (const node of nodes)
            expect(await node.round(switchTime)).toBe(1)
        now = switchTime + 30_000
        for (const node of nodes)
            await node.receive(envelope(next, signatures, switchTime))
        expect(nodes.map(node => node.hash === hashOf(next))).toEqual(nodes.map(() => true))
    }

    test('a grow 5 -> 6 by a bare majority: a voter, a non-voter, an offline node and the joiner pinned by clusterConfigHash schedule and apply the next proposal', async () => {
        const grown = rawConfig(six, {decimals: 16})
        const grownSignatures = [0, 1, 2].map(i => sign(grown, i, T0 + i * 1000))
        now = T0 + 3 * minute
        const nodes = []
        for (const i of [0, 3]) {
            const node = await startNode(newHome(O), i)
            const pending = {...envelope(grown, grownSignatures, T), expirationDate: T0 + 60 * minute}
            await node.receive(envelope(O, oSignatures, T0 - 70 * minute), pending)
            nodes.push(node)
        }
        now = T + 5
        for (const node of nodes)
            expect(await node.round(T)).toBe(1)
        now = T + 30_000
        const echo = envelope(grown, grownSignatures, T)
        const offline = await startNode(newHome(O), 4)
        const joiner = await startNode(newHome(), 5, hashOf(grown))
        nodes.push(offline, joiner)
        for (const node of nodes)
            await node.receive(echo)
        expect(nodes.map(node => node.hash === hashOf(grown))).toEqual([true, true, true, true])
        expect(nodes.map(node => node.nonces().configFloor)).toEqual([T0, T0, T0, T0])

        now = T + 10 * minute
        const next = rawConfig(six, {decimals: 17})
        await scheduleAndApply(nodes, echo, next, [0, 1, 2, 3].map(i => sign(next, i, now + i * 1000)))
    })

    test('a shrink 6 -> 5 by a bare majority including the removed node: a voter, a non-voter and an offline node schedule and apply the next proposal', async () => {
        const O6 = rawConfig(six, {decimals: 14})
        const o6Signatures = six.map(i => sign(O6, i, T0 - 60 * minute))
        const shrunk = rawConfig(five, {decimals: 16})
        const shrunkSignatures = [0, 1, 2, 5].map((i, k) => sign(shrunk, i, T0 + k * 1000))
        now = T0 + 3 * minute
        const nodes = []
        for (const i of [0, 3]) {
            const node = await startNode(newHome(O6), i)
            const pending = {...envelope(shrunk, shrunkSignatures, T), expirationDate: T0 + 60 * minute}
            await node.receive(envelope(O6, o6Signatures, T0 - 70 * minute), pending)
            nodes.push(node)
        }
        now = T + 5
        for (const node of nodes)
            expect(await node.round(T)).toBe(1)
        now = T + 30_000
        const echo = envelope(shrunk, shrunkSignatures, T)
        nodes.push(await startNode(newHome(O6), 4))
        for (const node of nodes)
            await node.receive(echo)
        expect(nodes.map(node => node.hash === hashOf(shrunk))).toEqual([true, true, true])

        now = T + 10 * minute
        const next = rawConfig(five, {decimals: 17})
        await scheduleAndApply(nodes, echo, next, [0, 1, 2].map(i => sign(next, i, now + i * 1000)))
    })

    test('a restart with the next update scheduled, and a restart between writing the landed config and removing the pending file', async () => {
        const nodes = await clusterOnP()
        now = T + 10 * minute
        const next = rawConfig(five, {decimals: 17})
        const nextSignatures = [0, 1, 2].map(i => sign(next, i, now + i * 1000))
        const echo = envelope(P, pSignatures, T)
        for (const node of nodes.slice(0, 2))
            await node.receive(echo, {...envelope(next, nextSignatures, T2), expirationDate: T2 + 30 * minute})
        //n0 restarts before the switch time; n1 stops after it wrote the landed config and before it removed the pending file
        const restarted = await startNode(nodes[0].home, 0)
        expect(restarted.pendingHash).toBe(hashOf(next))
        now = T2 + 5
        expect(await restarted.round(T2)).toBe(1)
        expect(restarted.hash).toBe(hashOf(next))
        fs.writeFileSync(path.join(nodes[1].home, '.config.json'), JSON.stringify(new Config(next).toPlainObject()))
        const recovered = await startNode(nodes[1].home, 1)
        expect(recovered.hash).toBe(hashOf(next))
        expect(recovered.pendingHash).toBeNull()
        expect(recovered.nonces().configFloor).toBe(T + 10 * minute)

        now = T2 + 10 * minute
        const later = rawConfig(five, {decimals: 18})
        const laterSignatures = [0, 1, 2].map(i => sign(later, i, now + i * 1000))
        await scheduleAndApply([restarted, recovered], envelope(next, nextSignatures, T2), later, laterSignatures)
    })

    test('an update cancelled before its switch time, and one that expired after a failed first round, are followed by the next proposal', async () => {
        const nodes = await clusterOnP()
        const echo = envelope(P, pSignatures, T)
        const [cancelling, expiring] = nodes
        now = T + 10 * minute
        const cancelled = rawConfig(five, {decimals: 17})
        const cancelledSignatures = [0, 1, 2].map(i => sign(cancelled, i, now + i * 1000))
        await cancelling.receive(echo, {...envelope(cancelled, cancelledSignatures, T2), expirationDate: T2 + 30 * minute})
        expect(cancelling.pendingHash).toBe(hashOf(cancelled))
        now = T + 12 * minute
        await cancelling.receive(echo) //the initiator withdrew it
        expect(cancelling.pendingHash).toBeNull()

        now = T + 13 * minute
        const expired = rawConfig(five, {decimals: 18})
        const expiredSignatures = [0, 1, 2].map(i => sign(expired, i, now + i * 1000))
        await expiring.receive(echo, {...envelope(expired, expiredSignatures, T2), expirationDate: T2 + 90_000})
        now = T2 + 5
        expect(await expiring.round(T2, false)).toBe(1)
        now = T2 + 2 * minute + 5
        expect(await expiring.round(T2 + 2 * minute)).toBe(0) //the retry would end after the expiration date
        now = T2 + 3 * minute
        await expiring.receive(echo) //rejected at its expiration date
        expect(expiring.pendingHash).toBeNull()
        expect(expiring.hash).toBe(hashOf(P))

        now = T2 + 5 * minute
        const next = rawConfig(five, {decimals: 19})
        await scheduleAndApply([cancelling, expiring], echo, next, [0, 1, 2].map(i => sign(next, i, now + i * 1000)))
    })
})
