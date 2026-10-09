/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')
const {Config} = require('@reflector/reflector-shared')

//the settings manager resolves its file paths from container.homeDir when it is loaded, so the home is a fresh
//temporary directory, emptied file by file after each test
jest.mock('../../src/domain/container', () => ({
    homeDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reflector-persistence-')),
    settingsManager: null,
    tradesManager: {setNodes: jest.fn()}
}))
jest.mock('../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 0),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways', CONFIG_FLOOR: 'configFloor'}
}))
jest.mock('../../src/domain/runners/runner-manager', () => ({setContracts: jest.fn(), start: jest.fn()}))
jest.mock('../../src/domain/nodes/nodes-manager', () => ({setNodes: jest.fn(), broadcast: jest.fn(), sendTo: jest.fn(), getConnectedNodes: jest.fn(() => [])}))
jest.mock('../../src/domain/statistics-manager', () => ({setContractIds: jest.fn(), setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../src/domain/data-sources-manager', () => ({setDataSources: jest.fn(), setGateways: jest.fn(), get: jest.fn()}))

const logger = require('../../src/logger')
const container = require('../../src/domain/container')
const nonceManager = require('../../src/ws-server/nonce-manager')
const SettingsManager = require('../../src/domain/settings-manager')

const home = container.homeDir
const file = name => path.join(home, name)
const kps = [Keypair.random(), Keypair.random(), Keypair.random()]
const systemAccount = Keypair.random().publicKey()
const posixTest = process.platform === 'win32' ? test.skip : test

/**
 * @param {number} decimals - distinguishes one config from another
 * @returns {object} a valid raw cluster config
 */
function rawConfig(decimals) {
    const nodes = {}
    kps.forEach((kp, i) => {
        nodes[kp.publicKey()] = {pubkey: kp.publicKey(), url: `ws://127.0.0.1:300${i}`, domain: `node${i}.example.com`}
    })
    return {contracts: {}, nodes, wasmHash: {oracle: 'a'.repeat(64)}, minDate: 0, systemAccount, network: 'testnet', decimals}
}

/**
 * @param {number} decimals - config to store as the current one
 */
function storeCurrent(decimals) {
    fs.writeFileSync(file('.config.json'), JSON.stringify(new Config(rawConfig(decimals)).toPlainObject()))
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

beforeEach(() => {
    for (const name of fs.readdirSync(home))
        fs.rmSync(file(name), {force: true})
    fs.writeFileSync(file('app.config.json'), JSON.stringify({
        secret: kps[0].secret(),
        dataSources: {exchanges: {type: 'api', name: 'exchanges', providers: ['binance']}}
    }))
    logger.error.mockClear()
    logger.warn.mockClear()
})

afterAll(() => {
    for (const name of fs.readdirSync(home))
        fs.rmSync(file(name), {force: true})
    fs.rmdirSync(home)
})

describe('SettingsManager boot with a pending config it cannot use', () => {
    test('a pending config equal to the current one is dropped instead of stopping the boot', async () => {
        storeCurrent(14)
        fs.writeFileSync(file('.pending.config.json'), JSON.stringify({config: rawConfig(14), signatures: [], timestamp: 1}))
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.pendingConfig).toBeFalsy()
        expect(fs.existsSync(file('.pending.config.json'))).toBe(false)
        expect(manager.config.decimals).toBe(14)
    })

    test('on that path the floor applyPendingUpdate would have raised is raised', async () => {
        storeCurrent(14)
        fs.writeFileSync(file('.pending.config.json'), JSON.stringify({config: rawConfig(14), signatures: [], timestamp: 1}))
        const manager = new SettingsManager()
        const raise = jest.spyOn(manager, 'raisePendingConfigFloor')

        await manager.init()

        expect(raise).toHaveBeenCalledWith(0) //no counted signature in this fixture
    })

    test('with signed votes, the floor is the lowest counted nonce and is stored', async () => {
        storeCurrent(14)
        const raw = rawConfig(14)
        const outsider = Keypair.random()
        const signatures = [sign(raw, kps[0], 5_000), sign(raw, kps[1], 7_000), sign(raw, kps[2], 6_000), sign(raw, outsider, 9_000)]
        signatures.push(sign(raw, Keypair.random(), 1_000)) //a second outsider, below every counted nonce
        fs.writeFileSync(file('.pending.config.json'), JSON.stringify({config: raw, signatures, timestamp: 1}))
        nonceManager.setNonce.mockClear()

        await new SettingsManager().init()

        //the outsiders' entries are not counted against the adopted set
        expect(nonceManager.setNonce).toHaveBeenCalledWith('pendingConfig', 5_000)
        expect(nonceManager.setNonce).toHaveBeenCalledWith('configFloor', 5_000)
        expect(fs.existsSync(file('.pending.config.json'))).toBe(false)
    })

    test('a floor that cannot be stored stops the boot and keeps the pending file for the next one', async () => {
        storeCurrent(14)
        const raw = rawConfig(14)
        const content = JSON.stringify({config: raw, signatures: [sign(raw, kps[0], 5_000), sign(raw, kps[1], 7_000)], timestamp: 1})
        fs.writeFileSync(file('.pending.config.json'), content)
        nonceManager.setNonce.mockImplementationOnce(() => {
            throw new Error('ENOSPC: no space left on device')
        })

        await expect(new SettingsManager().init()).rejects.toThrow('ENOSPC')

        expect(fs.readFileSync(file('.pending.config.json'), 'utf8')).toBe(content)
        expect(fs.existsSync(file('.pending.config.json.corrupt'))).toBe(false)
    })

    test('a torn pending file is moved aside, kept byte for byte, and the node boots', async () => {
        storeCurrent(14)
        fs.writeFileSync(file('.pending.config.json'), '{"config": {')
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.pendingConfig).toBeFalsy()
        expect(fs.existsSync(file('.pending.config.json'))).toBe(false)
        expect(fs.readFileSync(file('.pending.config.json.corrupt'), 'utf8')).toBe('{"config": {')
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: expect.stringContaining('moved aside'),
            err: 'not valid JSON'
        }))
    })

    test('a pending config with no current config beside it is moved aside', async () => {
        fs.writeFileSync(file('.pending.config.json'), JSON.stringify({config: rawConfig(15), signatures: [], timestamp: 1}))

        await new SettingsManager().init()

        expect(fs.existsSync(file('.pending.config.json.corrupt'))).toBe(true)
    })

    test('a valid pending update is still scheduled', async () => {
        storeCurrent(14)
        fs.writeFileSync(file('.pending.config.json'), JSON.stringify({config: rawConfig(15), signatures: [], timestamp: 1}))
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.pendingConfig.config.decimals).toBe(15)
        expect(fs.existsSync(file('.pending.config.json.corrupt'))).toBe(false)
    })
})

describe('SettingsManager writes secrets owner-only and whole', () => {
    test('init restricts the home directory to its owner', async () => {
        const chmod = jest.spyOn(fs, 'chmodSync')
        try {
            await new SettingsManager().init()
            expect(chmod).toHaveBeenCalledWith(home, 0o700)
        } finally {
            chmod.mockRestore()
        }
    })

    test('the cluster config is replaced whole, leaving no temporary file', async () => {
        const manager = new SettingsManager()
        await manager.init()
        await manager.setConfig(new Config(rawConfig(16)), null)

        expect(JSON.parse(fs.readFileSync(file('.config.json'), 'utf8')).decimals).toBe(16)
        expect(fs.readdirSync(home).filter(name => name.endsWith('.tmp'))).toEqual([])
    })

    test('every home file the manager writes goes through a temporary file renamed over it', async () => {
        const rename = jest.spyOn(fs, 'renameSync')
        try {
            const manager = new SettingsManager()
            await manager.init() //writes gateways.json on a first boot
            await manager.setConfig(new Config(rawConfig(16)), null)
            manager.setPendingConfig(new (require('@reflector/reflector-shared').ConfigEnvelope)({config: rawConfig(17), signatures: [], timestamp: 1}), null)
            //the platform check keeps this test meaningful where the owner-only test below is skipped
            expect(rename.mock.calls.map(([from, to]) => [path.basename(from), path.basename(to)])).toEqual(
                ['gateways.json', '.config.json', '.pending.config.json'].map(name => [`${name}.${process.pid}.tmp`, name])
            )
        } finally {
            rename.mockRestore()
        }
    })

    posixTest('the cluster config, the pending config and the gateways file are owner-only', async () => {
        const manager = new SettingsManager()
        await manager.init() //writes gateways.json on a first boot
        await manager.setConfig(new Config(rawConfig(16)), null)
        manager.setPendingConfig(new (require('@reflector/reflector-shared').ConfigEnvelope)({config: rawConfig(17), signatures: [], timestamp: 1}), null)

        for (const name of ['.config.json', '.pending.config.json', 'gateways.json'])
            expect(fs.statSync(file(name)).mode & 0o777).toBe(0o600)
    })
})

describe('SettingsManager trace state', () => {
    test('a trace toggle leaves app.config.json byte for byte as it was', async () => {
        const manager = new SettingsManager()
        await manager.init()
        const before = fs.readFileSync(file('app.config.json'), 'utf8')

        manager.setTrace(true)

        expect(fs.readFileSync(file('app.config.json'), 'utf8')).toBe(before)
        expect(JSON.parse(fs.readFileSync(file('.state.json'), 'utf8'))).toEqual({trace: true})
        expect(manager.appConfig.trace).toBe(true)
    })

    test('the stored toggle wins over app.config.json at the next boot', async () => {
        const first = new SettingsManager()
        await first.init()
        first.setTrace(true)

        const second = new SettingsManager()
        logger.init.mockClear()
        await second.init()

        expect(second.appConfig.trace).toBe(true)
        //applied before the logger starts, so the boot itself logs at the stored level
        expect(logger.init).toHaveBeenCalledWith(true)
    })

    test('an unreadable state file keeps the setting from app.config.json', async () => {
        fs.writeFileSync(file('.state.json'), 'not json')
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.appConfig.trace).toBe(false)
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({msg: expect.stringContaining('trace state')}))
    })

    test('a stored trace that is not a boolean is ignored', async () => {
        fs.writeFileSync(file('.state.json'), JSON.stringify({trace: 'yes'}))
        const manager = new SettingsManager()

        await manager.init()

        expect(manager.appConfig.trace).toBe(false)
    })
})

describe('the boot recovery path raises the CONFIG floor too', () => {
    test('a stop between applying the update and storing its floors is recovered at the next boot', async () => {
        storeCurrent(14)
        const raw = rawConfig(15)
        const signatures = [sign(raw, kps[0], 5_000), sign(raw, kps[1], 7_000), sign(raw, kps[2], 6_000)]
        fs.writeFileSync(file('.pending.config.json'), JSON.stringify({config: raw, signatures, timestamp: 1}))
        const manager = new SettingsManager()
        await manager.init()
        expect(manager.pendingConfig.config.decimals).toBe(15)
        //the first floor write fails: the config is applied and nothing else is
        nonceManager.setNonce.mockImplementationOnce(() => {
            throw new Error('ENOSPC: no space left on device')
        })

        await expect(manager.applyPendingUpdate(0)).rejects.toThrow('ENOSPC')

        expect(JSON.parse(fs.readFileSync(file('.config.json'), 'utf8')).decimals).toBe(15)
        expect(fs.existsSync(file('.pending.config.json'))).toBe(true)

        nonceManager.setNonce.mockClear()
        await new SettingsManager().init()

        expect(nonceManager.setNonce).toHaveBeenCalledWith('pendingConfig', 5_000)
        expect(nonceManager.setNonce).toHaveBeenCalledWith('configFloor', 5_000)
        expect(fs.existsSync(file('.pending.config.json'))).toBe(false)
    })

    test('a pending config equal to the current one raises the CONFIG floor as applyPendingUpdate would', async () => {
        storeCurrent(14)
        fs.writeFileSync(file('.pending.config.json'), JSON.stringify({config: rawConfig(14), signatures: [], timestamp: 1}))
        const manager = new SettingsManager()
        const raise = jest.spyOn(manager, 'raiseConfigFloor')

        await manager.init()

        expect(raise).toHaveBeenCalledWith(0) //no counted signature in this fixture
    })
})
