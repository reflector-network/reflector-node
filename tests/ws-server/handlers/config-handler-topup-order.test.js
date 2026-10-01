/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')
const {Config} = require('@reflector/reflector-shared')

//the settings manager resolves its file paths from container.homeDir when it is loaded
jest.mock('../../../src/domain/container', () => ({
    homeDir: require('path').join(require('os').tmpdir(), `reflector-topup-order-${process.pid}`),
    tradesManager: {setNodes: jest.fn()}
}))
jest.mock('../../../src/ws-server/nonce-manager', () => {
    const mockNonces = {}
    return {
        getNonce: jest.fn(type => mockNonces[type] || 0),
        setNonce: jest.fn((type, nonce) => {
            mockNonces[type] = nonce
        }),
        nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways', CONFIG_FLOOR: 'configFloor'},
        mockNonces
    }
})
jest.mock('../../../src/domain/runners/runner-manager', () => ({setContracts: jest.fn(), start: jest.fn()}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({setNodes: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setContractIds: jest.fn()}))
jest.mock('../../../src/domain/data-sources-manager', () => ({setDataSources: jest.fn(), setGateways: jest.fn()}))

const container = require('../../../src/domain/container')
const nonceManager = require('../../../src/ws-server/nonce-manager')
const logger = require('../../../src/logger')
const SettingsManager = require('../../../src/domain/settings-manager')
const ConfigHandler = require('../../../src/ws-server/handlers/config-handler')

const kps = Array.from({length: 5}, () => Keypair.random())
const systemAccount = Keypair.random().publicKey()
const minute = 60_000
const T0 = 1_800_000_000_000
const T = T0 + 4 * minute //P's switch time
const T2 = T + 30 * minute //Q's switch time

/**
 * @param {object} [overrides] - fields merged over the defaults
 * @returns {object} raw config over the five nodes
 */
function rawConfig(overrides = {}) {
    const nodes = {}
    kps.forEach((kp, i) => {
        nodes[kp.publicKey()] = {pubkey: kp.publicKey(), url: `ws://127.0.0.1:300${i}`, domain: `node${i}.example.com`}
    })
    return {contracts: {}, nodes, wasmHash: {oracle: 'a'.repeat(64)}, minDate: 0, systemAccount, network: 'testnet', decimals: 14, ...overrides}
}

/**
 * @param {object} raw - raw config
 * @param {number} i - index of the signer
 * @param {number} nonce - signature nonce
 * @returns {object} raw signature entry
 */
function sign(raw, i, nonce) {
    const hash = new Config(raw).getSignaturePayloadHash(kps[i].publicKey(), nonce, false)
    return {pubkey: kps[i].publicKey(), nonce, signature: Buffer.from(kps[i].sign(Buffer.from(hash, 'hex'))).toString('hex')}
}

const envelope = (config, signatures, timestamp) => ({config, signatures, timestamp, allowEarlySubmission: false})

//O runs before P. P is applied by 3 of 5 at T; Q, the next proposal, is signed by 3 of 5 at T+5 min; operators 3 and 4
//then top up P at T+10 min, after Q was signed (measured as G3 "topup-after-Q-signed")
const O = rawConfig({decimals: 14})
const P = rawConfig({decimals: 16})
const Q = rawConfig({decimals: 17})
const pSignatures = [0, 1, 2].map(i => sign(P, i, T0 + i * 1000))
const qSignatures = [0, 1, 2].map(i => sign(Q, i, T + 5 * minute + i * 1000))
const pToppedUp = [...pSignatures, sign(P, 3, T + 10 * minute), sign(P, 4, T + 10 * minute + 1000)]
const hashOf = raw => new Config(raw).getHash()

/**
 * A node process with nothing but its home: the real SettingsManager and ConfigHandler over the mocked nonce store
 * @param {number} self - index of this node's key
 * @param {object} options - the config the node runs, and the operator's clusterConfigHash pin
 * @returns {SettingsManager}
 */
function startNode(self, {current = null, clusterConfigHash} = {}) {
    for (const key of Object.keys(nonceManager.mockNonces))
        delete nonceManager.mockNonces[key]
    const settingsManager = new SettingsManager()
    settingsManager.appConfig = {publicKey: kps[self].publicKey(), clusterConfigHash}
    settingsManager.config = current ? new Config(current) : null
    settingsManager.pendingConfig = null
    container.settingsManager = settingsManager
    return settingsManager
}

/**
 * @param {object} currentConfig - current config envelope
 * @param {object} [pendingConfig] - pending config envelope
 */
async function receive(currentConfig, pendingConfig) {
    await new ConfigHandler().handle({}, {data: {currentConfig, pendingConfig}})
}

const roles = [
    //a node that was offline across P; its operator topped P up after Q was signed
    ['a node offline across P', () => startNode(3, {current: O})],
    //a node joining the cluster P admitted, anchored to P; its operator topped P up after Q was signed
    ['a joiner anchored to P', () => startNode(4, {clusterConfigHash: hashOf(P)})]
]

describe('a top-up of the running config signed after the next proposal', () => {
    beforeAll(() => {
        fs.mkdirSync(container.homeDir, {recursive: true})
    })

    afterAll(() => {
        for (const file of ['.config.json', '.pending.config.json'])
            fs.rmSync(path.join(container.homeDir, file), {force: true})
        fs.rmdirSync(container.homeDir)
    })

    beforeEach(() => {
        jest.clearAllMocks()
        jest.spyOn(Date, 'now').mockReturnValue(T + 12 * minute)
    })

    afterEach(() => {
        jest.restoreAllMocks()
        for (const file of ['.config.json', '.pending.config.json'])
            fs.rmSync(path.join(container.homeDir, file), {force: true})
    })

    test.each(roles)('%s adopts P from the echo and schedules Q', async (_, start) => {
        const settingsManager = start()

        await receive(envelope(P, pToppedUp, T), envelope(Q, qSignatures, T2))

        expect(settingsManager.config.getHash()).toBe(hashOf(P))
        expect(settingsManager.pendingConfig?.config.getHash()).toBe(hashOf(Q))
        //the floors are P's earliest counted signature, which Q's signatures all follow
        expect(nonceManager.mockNonces.pendingConfig).toBe(T0)
        expect(nonceManager.mockNonces.configFloor).toBe(T0)
        expect(logger.error).not.toHaveBeenCalledWith(expect.objectContaining({msg: expect.stringContaining('superseded')}))
    })

    test.each(roles)('%s adopts Q as the current config once Q lands without it', async (_, start) => {
        const settingsManager = start()
        await receive(envelope(P, pToppedUp, T), envelope(Q, qSignatures, T2))
        //this node's own top-up is not stored as its CONFIG nonce: it postdates Q, and Q would be refused against it
        const configNonceAfterP = nonceManager.mockNonces.config

        jest.spyOn(Date, 'now').mockReturnValue(T2 + 30_000)
        await receive(envelope(Q, qSignatures, T2))

        expect(settingsManager.config.getHash()).toBe(hashOf(Q))
        expect(logger.warn).not.toHaveBeenCalledWith(expect.objectContaining({msg: 'Refusing the current config'}))
        expect(configNonceAfterP).toBe(T0)
        expect(nonceManager.mockNonces.configFloor).toBe(T + 5 * minute)
    })

    test.each(roles)('%s still refuses a replayed proposal signed just before P\'s earliest counted signature', async (_, start) => {
        const settingsManager = start()
        await receive(envelope(P, pToppedUp, T))
        expect(settingsManager.config.getHash()).toBe(hashOf(P))

        //R was signed by a majority and never landed; its latest signature is 1 ms before P's first
        const R = rawConfig({decimals: 13})
        const replayed = [0, 1, 2].map(i => sign(R, i, T0 - 3 + i))
        await receive(envelope(P, pToppedUp, T), envelope(R, replayed, T2))

        expect(settingsManager.pendingConfig).toBeNull()
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Config envelope is superseded: every counted signature predates the stored nonce',
            highestNonce: T0 - 1,
            currentNonce: T0,
            nonceType: nonceManager.nonceTypes.PENDING_CONFIG
        }))
    })

    test('top-ups made before Q is signed are accepted', async () => {
        const toppedUpFirst = [...pSignatures, sign(P, 3, T + 2 * minute), sign(P, 4, T + 2 * minute + 1000)]
        const settingsManager = startNode(3, {current: O})

        await receive(envelope(P, toppedUpFirst, T), envelope(Q, qSignatures, T2))

        expect(settingsManager.pendingConfig?.config.getHash()).toBe(hashOf(Q))
        expect(nonceManager.mockNonces.pendingConfig).toBe(T0)
    })
})
