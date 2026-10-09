/*eslint-disable no-undef */
const fs = require('fs')
const {Keypair} = require('@stellar/stellar-sdk')
const {Config, ConfigEnvelope} = require('@reflector/reflector-shared')

//the settings manager resolves its file paths from container.homeDir when it is loaded
jest.mock('../../src/domain/container', () => ({
    homeDir: require('path').join(require('os').tmpdir(), `reflector-settings-floor-${process.pid}`),
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
jest.mock('../../src/domain/nodes/nodes-manager', () => ({setNodes: jest.fn()}))
jest.mock('../../src/domain/statistics-manager', () => ({setContractIds: jest.fn()}))
jest.mock('../../src/domain/data-sources-manager', () => ({setDataSources: jest.fn(), setGateways: jest.fn()}))

const container = require('../../src/domain/container')
const nonceManager = require('../../src/ws-server/nonce-manager')
const SettingsManager = require('../../src/domain/settings-manager')
const ConfigHandler = require('../../src/ws-server/handlers/config-handler')

const settingsManager = new SettingsManager()

const kps = Array.from({length: 6}, () => Keypair.random())
const outsider = Keypair.random()
const systemAccount = Keypair.random().publicKey()

/**
 * @param {Keypair[]} set - node set
 * @param {object} [overrides] - fields merged over the defaults
 * @returns {object} raw config
 */
function rawConfig(set, overrides = {}) {
    const nodes = {}
    set.forEach((kp, i) => {
        nodes[kp.publicKey()] = {pubkey: kp.publicKey(), url: `ws://127.0.0.1:300${i}`, domain: `node${i}.example.com`}
    })
    return {contracts: {}, nodes, wasmHash: {oracle: 'a'.repeat(64)}, minDate: 0, systemAccount, network: 'testnet', decimals: 14, ...overrides}
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

describe('SettingsManager.applyPendingUpdate raises the pending-config floor', () => {
    const oldSet = kps.slice(0, 5)
    const grownRaw = rawConfig(kps, {decimals: 15})

    beforeAll(() => {
        fs.mkdirSync(container.homeDir, {recursive: true})
    })

    afterAll(() => {
        //only the files setConfig and setPendingConfig write, then the empty directory
        for (const file of ['.config.json', '.pending.config.json'])
            fs.rmSync(require('path').join(container.homeDir, file), {force: true})
        fs.rmdirSync(container.homeDir)
    })

    beforeEach(() => {
        for (const key of Object.keys(nonceManager.mockNonces))
            delete nonceManager.mockNonces[key]
        settingsManager.config = new Config(rawConfig(oldSet))
        settingsManager.pendingConfig = null
    })

    test('the floor becomes the lowest nonce that counted toward the applied update', async () => {
        nonceManager.mockNonces.pendingConfig = 1_000 //this node's own vote on an older proposal
        settingsManager.pendingConfig = new ConfigEnvelope({
            config: grownRaw,
            signatures: [sign(grownRaw, kps[0], 5_000), sign(grownRaw, kps[1], 7_000), sign(grownRaw, kps[2], 6_000)],
            timestamp: 1
        })

        await settingsManager.applyPendingUpdate(0)

        expect(settingsManager.config.getHash()).toBe(new Config(grownRaw).getHash())
        expect(settingsManager.pendingConfig).toBeNull()
        expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(5_000)
    })

    test('signatures that did not count - an outsider, the node the update adds, a forged entry - never set the floor', async () => {
        //each one below every counted nonce, so any of them that counted would set the floor
        const forged = {pubkey: kps[3].publicKey(), nonce: 4_000, signature: 'ab'.repeat(64)}
        settingsManager.pendingConfig = new ConfigEnvelope({
            config: grownRaw,
            signatures: [
                sign(grownRaw, kps[0], 5_000),
                sign(grownRaw, kps[1], 6_000),
                sign(grownRaw, kps[2], 6_500),
                sign(grownRaw, outsider, 4_100),
                sign(grownRaw, kps[5], 4_200), //joins with this update, so it is outside the set that voted
                forged
            ],
            timestamp: 1
        })

        await settingsManager.applyPendingUpdate(0)

        expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(5_000)
    })

    test('the floor is never lowered', async () => {
        nonceManager.mockNonces.pendingConfig = 9_000
        settingsManager.pendingConfig = new ConfigEnvelope({
            config: grownRaw,
            signatures: [sign(grownRaw, kps[0], 5_000), sign(grownRaw, kps[1], 7_000), sign(grownRaw, kps[2], 6_000)],
            timestamp: 1
        })

        await settingsManager.applyPendingUpdate(0)

        expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(9_000)
    })

    describe('the floor is capped at this node clock when the config is adopted', () => {
        const now = 1_800_000_000_000
        const hour = 60 * 60 * 1000
        const self = kps[3] //voted on neither the grow nor anything before it

        beforeEach(() => {
            jest.spyOn(Date, 'now').mockReturnValue(now)
            settingsManager.appConfig = {publicKey: self.publicKey()}
            container.settingsManager = settingsManager
        })

        afterEach(() => {
            jest.restoreAllMocks()
        })

        /**
         * The grow, applied by 3 of the old 5, one of them signing on a browser clock the given offset ahead
         * @param {number} fastSignerNonce - nonce the fast signer put on the grow
         * @returns {ConfigEnvelope}
         */
        function scheduleGrow(fastSignerNonce) {
            settingsManager.pendingConfig = new ConfigEnvelope({
                config: grownRaw,
                signatures: [
                    sign(grownRaw, kps[0], now - 10 * 60_000),
                    sign(grownRaw, kps[1], now - 9 * 60_000),
                    sign(grownRaw, kps[2], fastSignerNonce)
                ],
                timestamp: now - 60_000
            })
            return settingsManager.pendingConfig
        }

        /**
         * Hands the real config handler a CONFIG message: the echo of the grow, and a proposal on the grown set
         * @param {ConfigEnvelope} grow - the applied grow
         * @param {object} proposalRaw - raw config of the proposal
         * @param {Keypair[]} signers - signers of the proposal
         * @param {number} nonce - nonce every proposal signer uses
         */
        async function receiveProposal(grow, proposalRaw, signers, nonce) {
            await new ConfigHandler().handle({}, {
                data: {
                    currentConfig: grow.toPlainObject(),
                    pendingConfig: {
                        config: proposalRaw,
                        signatures: signers.map(kp => sign(proposalRaw, kp, nonce)),
                        timestamp: now + hour,
                        allowEarlySubmission: false
                    }
                }
            })
        }

        test('a grow signed on a clock hours ahead does not block a proposal signed a minute later on a correct clock', async () => {
            const grow = scheduleGrow(now + 5 * hour)
            await settingsManager.applyPendingUpdate(0)
            //the lowest counted nonce: the fast signer does not lift the floor at all
            expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(now - 10 * 60_000)

            //the fast signer does not sign the next proposal
            const nextRaw = rawConfig(kps, {decimals: 16})
            await receiveProposal(grow, nextRaw, [kps[0], kps[1], kps[3], kps[4]], now + 60_000)

            expect(settingsManager.pendingConfig?.config.getHash()).toBe(new Config(nextRaw).getHash())
        })

        test('a replay of the config before the grow, signed by a majority of the grown set, is refused as the current config', async () => {
            const grow = scheduleGrow(now - 8 * 60_000)
            await settingsManager.applyPendingUpdate(0)
            expect(nonceManager.getNonce(nonceManager.nonceTypes.CONFIG_FLOOR)).toBe(now - 10 * 60_000)

            //the config before the grow, which 4 of the grown 6 had signed a day earlier
            const oldRaw = rawConfig(oldSet)
            const oldSignatures = [0, 1, 2, 3].map(i => sign(oldRaw, kps[i], now - 24 * hour))
            const replayed = {config: oldRaw, signatures: oldSignatures, timestamp: now - 24 * hour}
            await new ConfigHandler().handle({}, {data: {currentConfig: replayed}})
            expect(settingsManager.config.getHash()).toBe(new Config(grownRaw).getHash())

            //after an operator tops the grow up to a majority of the grown set (RN 13), its echo verifies against the
            //raised floor, so it still clears a cancelled update
            const nextRaw = rawConfig(kps, {decimals: 16})
            await receiveProposal(grow, nextRaw, [kps[0], kps[1], kps[3], kps[4]], now + 60_000)
            expect(settingsManager.pendingConfig?.config.getHash()).toBe(new Config(nextRaw).getHash())
            const toppedUp = grow.toPlainObject()
            toppedUp.signatures.push(sign(grownRaw, kps[3], now - 7 * 60_000))
            await new ConfigHandler().handle({}, {data: {currentConfig: toppedUp}})
            expect(settingsManager.pendingConfig).toBeNull()
        })

        test('a grow whose every signer signed on a clock hours ahead raises the CONFIG floor no higher than this node clock', async () => {
            settingsManager.pendingConfig = new ConfigEnvelope({
                config: grownRaw,
                signatures: [0, 1, 2].map(i => sign(grownRaw, kps[i], now + 5 * hour)),
                timestamp: now - 60_000
            })

            await settingsManager.applyPendingUpdate(0)

            expect(nonceManager.getNonce(nonceManager.nonceTypes.CONFIG_FLOOR)).toBe(now)
            expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(now)
        })

        test('a replay of a proposal signed before the grow is still refused', async () => {
            const grow = scheduleGrow(now - 8 * 60_000)
            await settingsManager.applyPendingUpdate(0)
            expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(now - 10 * 60_000)

            //P1 was signed by 4 of the old 5 a day earlier and never landed; it counts 4 of the new 6
            const p1Raw = rawConfig(oldSet, {decimals: 13})
            await receiveProposal(grow, p1Raw, [kps[0], kps[1], kps[2], kps[3]], now - 24 * hour)

            expect(settingsManager.pendingConfig).toBeNull()
        })
    })

    test('raisePendingConfigFloor ignores anything but a larger safe integer', () => {
        nonceManager.mockNonces.pendingConfig = 100
        for (const value of [null, undefined, 0, 50, 100, NaN, Infinity, '200'])
            settingsManager.raisePendingConfigFloor(value)
        expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(100)

        settingsManager.raisePendingConfigFloor(101)
        expect(nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)).toBe(101)
    })

    test('raiseConfigFloor ignores anything but a larger positive safe integer', () => {
        nonceManager.mockNonces.configFloor = 100
        //the equal value first and the lower one after it, so a floor that took the last value seen would end below 100
        for (const value of [null, undefined, 0, -5, 100, 50, NaN, Infinity, '200'])
            settingsManager.raiseConfigFloor(value)
        expect(nonceManager.getNonce(nonceManager.nonceTypes.CONFIG_FLOOR)).toBe(100)

        settingsManager.raiseConfigFloor(101)
        expect(nonceManager.getNonce(nonceManager.nonceTypes.CONFIG_FLOOR)).toBe(101)
    })

    test('the floors are stored before the pending file is removed: a failure in between keeps them', async () => {
        settingsManager.pendingConfig = new ConfigEnvelope({
            config: grownRaw,
            signatures: [sign(grownRaw, kps[0], 5_000), sign(grownRaw, kps[1], 7_000), sign(grownRaw, kps[2], 6_000)],
            timestamp: 1
        })
        fs.writeFileSync(require('path').join(container.homeDir, '.pending.config.json'), '{}')
        const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {
            throw new Error('EIO: i/o error, unlink')
        })
        try {
            await expect(settingsManager.applyPendingUpdate(0)).rejects.toThrow('EIO')
        } finally {
            unlink.mockRestore()
        }

        expect(settingsManager.config.getHash()).toBe(new Config(grownRaw).getHash())
        expect(nonceManager.mockNonces.pendingConfig).toBe(5_000)
        expect(nonceManager.mockNonces.configFloor).toBe(5_000)
    })

    test('the CONFIG floor becomes the lowest nonce that counted toward the applied update', async () => {
        settingsManager.pendingConfig = new ConfigEnvelope({
            config: grownRaw,
            signatures: [sign(grownRaw, kps[0], 5_000), sign(grownRaw, kps[1], 7_000), sign(grownRaw, kps[2], 6_000)],
            timestamp: 1
        })

        await settingsManager.applyPendingUpdate(null)

        expect(nonceManager.mockNonces.configFloor).toBe(5_000)
    })
})
