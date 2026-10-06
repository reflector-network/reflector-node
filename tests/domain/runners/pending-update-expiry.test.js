/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const {Config, ConfigEnvelope} = require('@reflector/reflector-shared')

jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 0),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways', CONFIG_FLOOR: 'configFloor'}
}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../../src/utils', () => ({
    submitTransaction: jest.fn(),
    getAccount: jest.fn(() => Promise.resolve({accountId: () => 'GACCOUNT', sequenceNumber: () => '1'})),
    txTimeoutMessage: 'Transaction timed out',
    isDebugging: () => false,
    withDeadline: promise => promise
}))

const container = require('../../../src/domain/container')
const ConfigHandler = require('../../../src/ws-server/handlers/config-handler')
const ClusterRunner = require('../../../src/domain/runners/cluster-runner')
const SettingsManager = require('../../../src/domain/settings-manager')

const kps = Array.from({length: 6}, () => Keypair.random())
const systemAccount = Keypair.random().publicKey()
const switchTime = 1_700_000_100_000

/**
 * @param {number} decimals - distinguishes one config from another
 * @returns {object} raw config over the six keys
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

//After a node-set change applied by a bare majority the echo of the running config does not verify, so a CONFIG that
//omits a held update is ignored until an hour past the switch time, and every node holding the update builds and
//applies it at its switch time
describe('an update cancelled before its switch time after a bare-majority node-set change', () => {
    test('stays held when the orchestrator omits it, and the runner still builds and applies it at its switch time', async () => {
        //5 -> 6 applied by 3 of the old 5: the echo carries those three votes, one short of a majority of the six
        const appliedRaw = rawConfig(15)
        const echoSignatures = kps.slice(0, 3).map(kp => sign(appliedRaw, kp, 1_700_000_050_000))
        const echo = {config: appliedRaw, signatures: echoSignatures, timestamp: 1, allowEarlySubmission: false}
        const nextRaw = rawConfig(16)
        const heldSignatures = kps.slice(0, 4).map(kp => sign(nextRaw, kp, 1_700_000_060_000))
        const held = new ConfigEnvelope({config: nextRaw, signatures: heldSignatures, timestamp: switchTime, allowEarlySubmission: false})
        const settings = {
            appConfig: {publicKey: kps[3].publicKey()},
            config: new Config(appliedRaw),
            pendingConfig: held,
            setConfig: jest.fn(),
            setPendingConfig: jest.fn(),
            clearPendingConfig: jest.fn(() => {
                settings.pendingConfig = null
            }),
            raisePendingConfigFloor: jest.fn(),
            raiseConfigFloor: jest.fn(),
            applyPendingUpdate: jest.fn(),
            getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']})
        }
        container.settingsManager = settings
        const now = jest.spyOn(Date, 'now')
        try {
            //the orchestrator cancelled the update a minute before its switch time: CONFIG carries the echo and no pending
            now.mockReturnValue(switchTime - 60_000)
            await new ConfigHandler().handle({}, {data: {currentConfig: echo}})
            expect(settings.clearPendingConfig).not.toHaveBeenCalled()
            expect(settings.pendingConfig).toBe(held)

            //at the switch time the runner builds and applies the cancelled update
            now.mockReturnValue(switchTime + 1)
            const runner = new ClusterRunner()
            runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve(null))
            expect(await runner.__workerFn(switchTime)).toBe(true)
            expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
            expect(settings.applyPendingUpdate).toHaveBeenCalledTimes(1)
        } finally {
            now.mockRestore()
        }
    })
})

//The expiration date E of a pending update. node-orchestrator refuses at PENDING a switch time T whose round would end
//after E (T + 61 s > E), so a round started at T fits before E; a round that fails is retried at the next 2-minute grid
//tick, T + 2 min, where the orchestrator finds E passed, rejects the update and notifies the nodes a second later
//(config-manager.js processPendingConfig, updateItems). The orchestrator sends E beside the pending envelope, and the
//node builds a round only when endsBeforeExpiration(tick, E) holds (the shared update schedule, the orchestrator's own rule);
//applyPendingUpdate adopts the envelope the round was built from when the pending config was cleared under it. A node
//that holds no E - one paired with an orchestrator that sends none - retries every tick, which the last case pins.
describe('a node skips a round that would end after the pending config expires, and adopts an update that landed after it was cleared', () => {
    //the orchestrator puts every switch time on the 2-minute grid; the switch time of the
    //first case is off it, and there the retry would come a minute after it
    const gridSwitchTime = 1_700_000_160_000
    const retryTick = gridSwitchTime + 120_000
    const expirationDate = gridSwitchTime + 90_000
    let now = null

    /**
     * @param {number} signers - how many of the six keys sign the echo of the running config
     * @param {number} [expiry] - the expiration date the node holds beside the update; null for none
     * @returns {{settings: object, echo: object, held: ConfigEnvelope}}
     */
    function setup(signers, expiry = expirationDate) {
        const appliedRaw = rawConfig(15)
        const echoSignatures = kps.slice(0, signers).map(kp => sign(appliedRaw, kp, 1_700_000_050_000))
        const echo = {config: appliedRaw, signatures: echoSignatures, timestamp: 1, allowEarlySubmission: false}
        const nextRaw = rawConfig(16)
        //distinct nonces, so the floors show which envelope they were computed from
        const heldSignatures = kps.slice(0, 4).map((kp, i) => sign(nextRaw, kp, 1_700_000_060_000 + i * 1_000))
        //the orchestrator's document carries the expiration date; the envelope a node holds drops it, and the node
        //keeps it beside the envelope
        const held = new ConfigEnvelope({
            config: nextRaw,
            signatures: heldSignatures,
            timestamp: gridSwitchTime,
            allowEarlySubmission: false,
            expirationDate
        })
        const settings = {
            appConfig: {publicKey: kps[3].publicKey()},
            config: new Config(appliedRaw),
            pendingConfig: held,
            pendingExpirationDate: expiry,
            setConfig: jest.fn(config => {
                settings.config = config
                return Promise.resolve()
            }),
            setPendingConfig: jest.fn(),
            clearPendingConfig: jest.fn(() => {
                settings.pendingConfig = null
                settings.pendingExpirationDate = null
            }),
            raisePendingConfigFloor: jest.fn(),
            raiseConfigFloor: jest.fn(),
            applyPendingUpdate: jest.fn(() => Promise.resolve()),
            getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']})
        }
        container.settingsManager = settings
        return {settings, echo, held}
    }

    /**
     * Runs the node from the switch time: at every tick the runner, then half a tick later the orchestrator's CONFIG
     * omitting the rejected update, until the held update is cleared
     * @param {{settings: object, echo: object}} state - from setup
     * @returns {Promise<{builtAt: number[], ticks: number}>}
     */
    async function runUntilCleared({settings, echo}) {
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.reject(new Error('Failed to submit transaction. See logs for details.')))
        const handler = new ConfigHandler()
        const builtAt = []
        let tick = gridSwitchTime
        let ticks = 0
        while (settings.pendingConfig && ticks < 100) {
            now.mockReturnValue(tick + 1)
            const calls = runner.__buildAndSubmitTransaction.mock.calls.length
            await runner.__workerFn(tick).catch(() => null)
            ticks++
            if (runner.__buildAndSubmitTransaction.mock.calls.length > calls)
                builtAt.push(tick)
            now.mockReturnValue(tick + 30_000)
            await handler.handle({}, {data: {currentConfig: echo}})
            now.mockReturnValue(tick + 61_000)
            tick = runner.__getNextTimestamp(tick)
        }
        return {builtAt, ticks}
    }

    beforeEach(() => {
        now = jest.spyOn(Date, 'now')
    })

    afterEach(() => {
        now.mockRestore()
    })

    test('the envelope a node holds carries no expiration date; the node keeps it beside the envelope', () => {
        const {held, settings} = setup(4)
        expect(held.expirationDate).toBeUndefined()
        expect(Object.keys(held.toPlainObject())).toEqual(['allowEarlySubmission', 'config', 'signatures', 'timestamp'])
        expect(settings.pendingExpirationDate).toBe(gridSwitchTime + 90_000)
    })

    test('a failed first round is not retried at the next grid tick, which would end after the expiration date', async () => {
        const {settings} = setup(4)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn()
            .mockImplementationOnce(() => Promise.reject(new Error('Failed to submit transaction. See logs for details.')))
            .mockImplementationOnce(() => Promise.resolve(null))

        now.mockReturnValue(gridSwitchTime + 1)
        await expect(runner.__workerFn(gridSwitchTime)).rejects.toThrow('Failed to submit transaction')
        now.mockReturnValue(gridSwitchTime + 61_000)
        expect(runner.__getNextTimestamp(gridSwitchTime)).toBe(retryTick)

        //the orchestrator rejects the update at this tick; the node, which now holds its expiration date, abstains
        now.mockReturnValue(retryTick + 1)
        expect(await runner.__workerFn(retryTick)).toBe(false)
        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        expect(settings.applyPendingUpdate).not.toHaveBeenCalled()
    })

    test('a verified rejection arriving during a round clears the held update, and the round that lands is adopted', async () => {
        //no expiration date held (an orchestrator that sends none), so the retry is built as before
        const {settings, echo, held} = setup(4, null)
        //the real applyPendingUpdate, over the stub's state
        settings.applyPendingUpdate = SettingsManager.prototype.applyPendingUpdate
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(async () => {
            //the orchestrator's CONFIG without pendingConfig, a second after its own retry-tick wake
            now.mockReturnValue(retryTick + 1_000)
            await new ConfigHandler().handle({}, {data: {currentConfig: echo}})
            return null //the retry landed
        })

        now.mockReturnValue(retryTick + 1)
        await expect(runner.__workerFn(retryTick)).resolves.toBe(true)
        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1) //by the handler, before the round landed
        expect(settings.pendingConfig).toBeNull()
        //the node follows the chain: the landed config, with the floors of the envelope that landed
        expect(settings.setConfig).toHaveBeenCalledTimes(1)
        expect(settings.setConfig.mock.calls[0][0]).toBe(held.config)
        expect(settings.config.getHash()).toBe(new Config(rawConfig(16)).getHash())
        //both floors are the lowest counted nonce of the landed envelope
        expect(settings.raisePendingConfigFloor).toHaveBeenCalledWith(1_700_000_060_000)
        expect(settings.raiseConfigFloor).toHaveBeenCalledWith(1_700_000_060_000)
    })

    test('after a bare-majority node-set change the rejection does not verify, and the update is built once, not 31 times', async () => {
        const state = setup(3)

        const {builtAt, ticks} = await runUntilCleared(state)

        expect(builtAt).toEqual([gridSwitchTime])
        expect(ticks).toBe(31) //the node still holds the update until the hour-late clear, but builds no round past E
        expect(state.settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        expect(state.settings.applyPendingUpdate).not.toHaveBeenCalled()
    })

    test('a node that holds no expiration date still retries every tick for an hour: 31 builds, as before', async () => {
        const state = setup(3, null)

        const {builtAt} = await runUntilCleared(state)

        expect(builtAt).toHaveLength(31)
        expect(builtAt).toEqual(Array.from({length: 31}, (_, i) => gridSwitchTime + i * 120_000))
        expect(state.settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        expect(state.settings.applyPendingUpdate).not.toHaveBeenCalled()
    })
})
