/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')
const {Config, ConfigEnvelope} = require('@reflector/reflector-shared')

//the settings manager resolves its file paths from container.homeDir when it is loaded, so the home is a fresh
//temporary directory, emptied file by file after each test
jest.mock('../../src/domain/container', () => ({
    homeDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reflector-landed-update-')),
    settingsManager: null,
    tradesManager: {setNodes: jest.fn()}
}))
jest.mock('../../src/ws-server/nonce-manager', () => {
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
jest.mock('../../src/domain/runners/runner-manager', () => ({setContracts: jest.fn(), start: jest.fn()}))
jest.mock('../../src/domain/nodes/nodes-manager', () => ({setNodes: jest.fn(), broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../src/domain/statistics-manager', () => ({setContractIds: jest.fn(), setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../src/domain/data-sources-manager', () => ({setDataSources: jest.fn(), setGateways: jest.fn(), get: jest.fn()}))
jest.mock('../../src/utils', () => ({
    ...jest.requireActual('../../src/utils'),
    getAccount: jest.fn(() => Promise.resolve({accountId: () => 'GACCOUNT', sequenceNumber: () => '1'}))
}))

const logger = require('../../src/logger')
const container = require('../../src/domain/container')
const nonceManager = require('../../src/ws-server/nonce-manager')
const SettingsManager = require('../../src/domain/settings-manager')
const ConfigHandler = require('../../src/ws-server/handlers/config-handler')
const ClusterRunner = require('../../src/domain/runners/cluster-runner')

const home = container.homeDir
const file = name => path.join(home, name)
const kps = [Keypair.random(), Keypair.random(), Keypair.random()]
const systemAccount = Keypair.random().publicKey()
const T = 1_800_000_000_000 //on the two-minute grid

/**
 * @param {number} decimals - distinguishes one config from another
 * @returns {object} a valid raw cluster config over the three keys
 */
function rawConfig(decimals) {
    const nodes = {}
    kps.forEach((kp, i) => {
        nodes[kp.publicKey()] = {pubkey: kp.publicKey(), url: `ws://127.0.0.1:300${i}`, domain: `node${i}.example.com`}
    })
    return {contracts: {}, nodes, wasmHash: {oracle: 'a'.repeat(64)}, minDate: 0, systemAccount, network: 'testnet', decimals}
}

/**
 * @param {object} raw - raw config
 * @param {Keypair} kp - signer
 * @param {number} nonce - signature nonce
 * @returns {object} raw signature entry
 */
function sign(raw, kp, nonce) {
    const hash = new Config(raw).getSignaturePayloadHash(kp.publicKey(), nonce, false)
    return {pubkey: kp.publicKey(), nonce, signature: Buffer.from(kp.sign(Buffer.from(hash, 'hex'))).toString('hex')}
}

/**
 * @param {number} decimals - config of the envelope
 * @param {number[]} nonces - nonce of each signer, in key order
 * @param {number} [timestamp] - switch time
 * @returns {object} raw envelope signed by as many keys as nonces are given
 */
function rawEnvelope(decimals, nonces, timestamp = T) {
    const raw = rawConfig(decimals)
    return {config: raw, signatures: nonces.map((nonce, i) => sign(raw, kps[i], nonce)), timestamp, allowEarlySubmission: false}
}

/**
 * A booted settings manager running config 14; this node is the third key
 * @returns {Promise<SettingsManager>}
 */
async function boot() {
    fs.writeFileSync(file('.config.json'), JSON.stringify(new Config(rawConfig(14)).toPlainObject()))
    const manager = new SettingsManager()
    await manager.init()
    container.settingsManager = manager
    return manager
}

/**
 * @returns {object|null} the stored pending file
 */
function storedPending() {
    return fs.existsSync(file('.pending.config.json')) ? JSON.parse(fs.readFileSync(file('.pending.config.json'), 'utf8')) : null
}

beforeEach(() => {
    for (const name of fs.readdirSync(home))
        fs.rmSync(file(name), {force: true})
    fs.writeFileSync(file('app.config.json'), JSON.stringify({
        secret: kps[2].secret(),
        dataSources: {exchanges: {type: 'api', name: 'exchanges', providers: ['binance']}}
    }))
    for (const key of Object.keys(nonceManager.mockNonces))
        delete nonceManager.mockNonces[key]
    logger.error.mockClear()
})

afterEach(() => {
    jest.restoreAllMocks()
})

afterAll(() => {
    for (const name of fs.readdirSync(home))
        fs.rmSync(file(name), {force: true})
    fs.rmdirSync(home)
})

describe('SettingsManager keeps the pending config expiry beside the envelope', () => {
    test('a valid expiration date is kept, stored beside the envelope in the pending file, and survives a restart', async () => {
        const manager = await boot()
        const envelope = new ConfigEnvelope(rawEnvelope(15, [5_000, 6_000]))

        manager.setPendingConfig(envelope, null, true, T + 90_000)

        expect(manager.pendingExpirationDate).toBe(T + 90_000)
        const {expirationDate, ...stored} = storedPending()
        expect(expirationDate).toBe(T + 90_000)
        expect(stored).toEqual(JSON.parse(JSON.stringify(envelope.toPlainObject())))
        expect(Object.keys(envelope.toPlainObject())).toEqual(['allowEarlySubmission', 'config', 'signatures', 'timestamp'])

        const restarted = new SettingsManager()
        await restarted.init()
        expect(restarted.pendingConfig.config.getHash()).toBe(envelope.config.getHash())
        expect(restarted.pendingExpirationDate).toBe(T + 90_000)
    })

    test('anything but a positive safe integer is ignored, and the file then carries no expiration date', async () => {
        const manager = await boot()
        const envelope = new ConfigEnvelope(rawEnvelope(15, [5_000, 6_000]))
        //'1e400' parses to Infinity, as a JSON 1e400 does
        const values = [String(T + 90_000), -5, 0, NaN, Number('1e400'), -Infinity, T + 0.5, null, undefined, {}, [T + 90_000], true]
        for (const value of values) {
            manager.setPendingConfig(envelope, null, true, value)
            expect(manager.pendingExpirationDate).toBeNull()
            expect('expirationDate' in storedPending()).toBe(false)
        }

        const restarted = new SettingsManager()
        await restarted.init()
        expect(restarted.pendingConfig.config.getHash()).toBe(envelope.config.getHash())
        expect(restarted.pendingExpirationDate).toBeNull()
    })

    test('a CONFIG for the held update refreshes it; a different update leaves it alone; clearing drops it', async () => {
        const manager = await boot()
        const handler = new ConfigHandler()
        const echo = rawEnvelope(14, [1_000, 1_000])
        const held = rawEnvelope(15, [5_000, 6_000])

        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: {...held, expirationDate: T + 90_000}}})
        expect(manager.pendingExpirationDate).toBe(T + 90_000)
        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: {...held, expirationDate: T + 150_000}}})
        expect(manager.pendingExpirationDate).toBe(T + 150_000)
        expect(storedPending().expirationDate).toBe(T + 150_000)

        //another update while this one is held is refused, and does not touch its expiry
        const other = rawEnvelope(16, [7_000, 8_000])
        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: {...other, expirationDate: T + 10_000}}})
        expect(manager.pendingConfig.config.getHash()).toBe(new Config(held.config).getHash())
        expect(manager.pendingExpirationDate).toBe(T + 150_000)

        //an orchestrator that sends no expiration date: the node falls back to building every due round
        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: held}})
        expect(manager.pendingExpirationDate).toBeNull()
        expect('expirationDate' in storedPending()).toBe(false)

        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: {...held, expirationDate: T + 90_000}}})
        await handler.handle({}, {data: {currentConfig: echo}})
        expect(manager.pendingConfig).toBeNull()
        expect(manager.pendingExpirationDate).toBeNull()
    })
})

describe('applyPendingUpdate adopts the update that landed after the pending config was cleared', () => {
    const baseHash = new Config(rawConfig(14)).getHash()
    const landedHash = new Config(rawConfig(15)).getHash()
    //a majority of the running set, signed after everything else
    const verifiedEcho = rawEnvelope(14, [1_000, 1_000])

    /**
     * A booted node holding update 15, and a runner whose round at T runs `midFlight` before the transaction lands. This
     * node did not vote on update 15, which 2 of the 3 keys signed at 5 000 and 7 000: its stored PENDING_CONFIG nonce is
     * its vote on an earlier proposal, 4 000, below the landed envelope's lowest counted nonce, so raising the PENDING
     * floor to 5 000 shows
     * @param {function(SettingsManager): Promise<void>} midFlight - what arrives while the round is in flight
     * @returns {Promise<{manager: SettingsManager, runner: ClusterRunner, setConfig: jest.SpyInstance}>}
     */
    async function roundWith(midFlight) {
        const manager = await boot()
        manager.setPendingConfig(new ConfigEnvelope(rawEnvelope(15, [5_000, 7_000])), 4_000, true, T + 90_000)
        const setConfig = jest.spyOn(manager, 'setConfig')
        //the app config names no network; the round never reaches the network anyway
        jest.spyOn(manager, 'getBlockchainConnectorSettings')
            .mockReturnValue({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']})
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(async () => {
            await midFlight(manager)
            return null //the round landed
        })
        jest.spyOn(Date, 'now').mockReturnValue(T + 5)
        return {manager, runner, setConfig}
    }

    test('a verified clear during the round does not throw: the landed update is adopted with its own floors', async () => {
        const {manager, runner, setConfig} = await roundWith(async () => {
            await new ConfigHandler().handle({}, {data: {currentConfig: verifiedEcho}})
            expect(manager.pendingConfig).toBeNull()
        })

        await expect(runner.__workerFn(T)).resolves.toBe(true)

        expect(manager.config.getHash()).toBe(landedHash)
        expect(setConfig).toHaveBeenCalledTimes(1)
        expect(setConfig.mock.calls[0][0].getHash()).toBe(landedHash)
        expect(setConfig.mock.calls[0][1]).toBe(4_000) //the PENDING_CONFIG nonce read before the round
        expect(nonceManager.mockNonces.config).toBe(4_000)
        //both floors are raised to the landed envelope's lowest counted nonce
        expect(nonceManager.mockNonces.pendingConfig).toBe(5_000)
        expect(nonceManager.mockNonces.configFloor).toBe(5_000)
        expect(JSON.parse(fs.readFileSync(file('.config.json'), 'utf8')).decimals).toBe(15)
        expect(manager.pendingConfig).toBeNull()
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: expect.stringContaining('the chain moved without the orchestrator'),
            hash: landedHash
        }))
    })

    //no pending file holds the landed update, so the boot recovery path could not raise its floors after a stop: they
    //are stored before the config is written, as the config handler does
    test('when the pending config was cleared, the floors are stored before the landed config is written', async () => {
        const {manager, runner, setConfig} = await roundWith(async () => {
            await new ConfigHandler().handle({}, {data: {currentConfig: verifiedEcho}})
        })
        setConfig.mockImplementationOnce(() => Promise.reject(new Error('ENOSPC: no space left on device')))

        await expect(runner.__workerFn(T)).rejects.toThrow('ENOSPC')

        //both raised from the stored 4 000 and 0 before setConfig threw
        expect(nonceManager.mockNonces.pendingConfig).toBe(5_000)
        expect(nonceManager.mockNonces.configFloor).toBe(5_000)
        expect(nonceManager.mockNonces.config).toBeUndefined()
        expect(manager.config.getHash()).toBe(baseHash)
    })

    test('the echo of the landed config adopted mid-flight: nothing is adopted twice and nothing throws', async () => {
        const {manager, runner, setConfig} = await roundWith(async () => {
            //the orchestrator saw the round land before this node's submit returned
            await new ConfigHandler().handle({}, {data: {currentConfig: rawEnvelope(15, [5_000, 7_000, 6_000])}})
            expect(manager.config.getHash()).toBe(landedHash)
        })

        await expect(runner.__workerFn(T)).resolves.toBe(true)

        expect(setConfig).toHaveBeenCalledTimes(1) //by the handler
        expect(manager.config.getHash()).toBe(landedHash)
        expect(manager.pendingConfig).toBeNull()
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('the landed config already adopted while the update is still held: the held update is cleared, not adopted again', async () => {
        const {manager, runner, setConfig} = await roundWith(async m => {
            await m.setConfig(new Config(rawConfig(15)), null)
            expect(m.pendingConfig.config.getHash()).toBe(landedHash)
        })

        await expect(runner.__workerFn(T)).resolves.toBe(true)

        expect(setConfig).toHaveBeenCalledTimes(1)
        expect(manager.pendingConfig).toBeNull()
        expect(manager.pendingExpirationDate).toBeNull()
        expect(storedPending()).toBeNull()
    })

    test('a different update scheduled mid-flight is not cleared when the landed one is adopted', async () => {
        //this node votes on the next update too, which moves its stored vote
        const next = rawEnvelope(16, [8_000, 9_000, 9_500])
        const {manager, runner, setConfig} = await roundWith(async () => {
            const handler = new ConfigHandler()
            await handler.handle({}, {data: {currentConfig: verifiedEcho}})
            await handler.handle({}, {data: {currentConfig: verifiedEcho, pendingConfig: {...next, expirationDate: T + 600_000}}})
            expect(manager.pendingConfig.config.decimals).toBe(16)
            expect(nonceManager.mockNonces.pendingConfig).toBe(9_500)
        })

        await expect(runner.__workerFn(T)).resolves.toBe(true)

        expect(manager.config.getHash()).toBe(landedHash)
        //the nonce stored with the landed config is the one read before the round, not the vote on the next update
        expect(setConfig.mock.calls[0][1]).toBe(4_000)
        expect(nonceManager.mockNonces.config).toBe(4_000)
        expect(nonceManager.mockNonces.pendingConfig).toBe(9_500)
        expect(nonceManager.mockNonces.configFloor).toBe(5_000) //from the landed envelope, not the held one (8 000)
        expect(manager.pendingConfig.config.decimals).toBe(16)
        expect(manager.pendingExpirationDate).toBe(T + 600_000)
        expect(storedPending().config.decimals).toBe(16)
    })

    test('a base config that changed during the round adopts nothing', async () => {
        const {manager, runner, setConfig} = await roundWith(async () => {
            //a majority adopted another config meanwhile (the orchestrator's current config moved)
            await new ConfigHandler().handle({}, {data: {currentConfig: rawEnvelope(17, [3_000, 3_000])}})
            expect(manager.config.decimals).toBe(17)
        })

        await expect(runner.__workerFn(T)).resolves.toBe(true)

        expect(setConfig).toHaveBeenCalledTimes(1) //by the handler
        expect(manager.config.decimals).toBe(17)
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: expect.stringContaining('adopting nothing'),
            hash: landedHash,
            baseHash
        }))
    })

    test('with nothing to apply it logs and returns', async () => {
        const manager = await boot()

        await expect(manager.applyPendingUpdate(0)).resolves.toBeUndefined()

        expect(manager.config.decimals).toBe(14)
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({msg: expect.stringContaining('no update to apply')}))
    })
})
