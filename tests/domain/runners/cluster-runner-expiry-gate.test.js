/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')

//the builder is recorded, so the transaction a round builds can be compared with and without the expiration date
jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared'),
    buildUpdateTransaction: jest.fn(() => Promise.resolve({hashHex: 'recorded'}))
}))
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

const {Config, ConfigEnvelope, buildUpdateTransaction} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const logger = require('../../../src/logger')
const {getAccount} = require('../../../src/utils')
const ConfigHandler = require('../../../src/ws-server/handlers/config-handler')
const ClusterRunner = require('../../../src/domain/runners/cluster-runner')

const kps = Array.from({length: 3}, () => Keypair.random())
const systemAccount = Keypair.random().publicKey()
const T = 1_800_000_000_000 //on the two-minute grid
const retryTick = T + 120_000

/**
 * @param {number} decimals - distinguishes one config from another
 * @returns {object} raw config over the three keys
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

const currentRaw = rawConfig(14)
const nextRaw = rawConfig(15)
const echo = {config: currentRaw, signatures: kps.map(kp => sign(currentRaw, kp, 1_000)), timestamp: 1, allowEarlySubmission: false}
const heldRaw = {config: nextRaw, signatures: kps.map(kp => sign(nextRaw, kp, 2_000)), timestamp: T, allowEarlySubmission: false}

/**
 * A settings stub holding the update scheduled at T
 * @param {number} [expirationDate] - the expiration date the orchestrator sent with it; left out, the field is absent
 * @returns {object}
 */
function installSettings(expirationDate) {
    const settings = {
        appConfig: {publicKey: kps[0].publicKey()},
        config: new Config(currentRaw),
        pendingConfig: new ConfigEnvelope(heldRaw),
        setConfig: jest.fn(),
        setPendingConfig: jest.fn(),
        clearPendingConfig: jest.fn(),
        raisePendingConfigFloor: jest.fn(),
        raiseConfigFloor: jest.fn(),
        applyPendingUpdate: jest.fn(() => Promise.resolve()),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']})
    }
    if (expirationDate !== undefined)
        settings.pendingExpirationDate = expirationDate
    container.settingsManager = settings
    return settings
}

/**
 * Runs one round at a tick and reports whether it was built; the round's builder is run once, as the first attempt does
 * @param {number} tick - the sync tick
 * @returns {Promise<{processed: boolean, runner: ClusterRunner}>}
 */
async function round(tick) {
    const runner = new ClusterRunner()
    runner.__buildAndSubmitTransaction = jest.fn(async (builder, account, fee) => {
        await builder(account, fee, (tick + 30_000) / 1000)
        return null
    })
    jest.spyOn(Date, 'now').mockReturnValue(tick + 5)
    const processed = await runner.__workerFn(tick)
    return {processed, runner}
}

beforeEach(() => {
    buildUpdateTransaction.mockClear()
    getAccount.mockClear()
    logger.info.mockClear()
})

afterEach(() => {
    jest.restoreAllMocks()
})

describe('a node skips a round that would end after the pending config expires', () => {
    test('a round whose last attempt and poll end exactly at the expiration date is built', async () => {
        const settings = installSettings(T + 61_000)

        const {processed, runner} = await round(T)

        expect(processed).toBe(true)
        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        expect(runner.__buildAndSubmitTransaction.mock.calls[0][3]).toBe(T)
        expect(settings.applyPendingUpdate).toHaveBeenCalledTimes(1)
    })

    test('a round a millisecond too long is not built, and nothing is read for it', async () => {
        const settings = installSettings(T + 60_999)

        const {processed, runner} = await round(T)

        expect(processed).toBe(false)
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(getAccount).not.toHaveBeenCalled()
        expect(settings.applyPendingUpdate).not.toHaveBeenCalled()
        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'The update round would end after the proposal expires; not building it',
            syncTimestamp: T,
            expirationDate: T + 60_999
        }))
    })

    test('the gate is per round: the retry tick is judged on its own end', async () => {
        installSettings(T + 90_000)
        expect((await round(T)).processed).toBe(true)
        expect((await round(retryTick)).processed).toBe(false)

        installSettings(retryTick + 61_000)
        expect((await round(retryTick)).processed).toBe(true)
        installSettings(retryTick + 60_999)
        expect((await round(retryTick)).processed).toBe(false)
    })

    test('without an expiration date, as from an orchestrator that does not send one, every due round is built', async () => {
        for (const expirationDate of [undefined, null]) {
            installSettings(expirationDate)
            for (const tick of [T, retryTick, T + 60 * 60_000]) {
                const {processed, runner} = await round(tick)
                expect(processed).toBe(true)
                expect(runner.__buildAndSubmitTransaction.mock.calls[0][3]).toBe(tick)
            }
        }
    })

    test('the transaction a round builds is the same with and without the expiration date', async () => {
        const builds = []
        for (const expirationDate of [undefined, T + 61_000, T + 365 * 24 * 60 * 60_000]) {
            installSettings(expirationDate)
            buildUpdateTransaction.mockClear()
            const {runner} = await round(T)
            expect(buildUpdateTransaction).toHaveBeenCalledTimes(1)
            const [builder, account, fee, syncTimestamp] = runner.__buildAndSubmitTransaction.mock.calls[0]
            expect(typeof builder).toBe('function')
            const params = buildUpdateTransaction.mock.calls[0][0]
            builds.push({
                account: account.accountId(),
                fee,
                syncTimestamp,
                timestamp: params.timestamp,
                network: params.network,
                sorobanRpc: params.sorobanRpc,
                newConfig: params.newConfig.getHash(),
                currentConfig: params.currentConfig.getHash(),
                buildFee: params.fee,
                maxTime: params.maxTime,
                keys: Object.keys(params).sort()
            })
        }
        expect(builds[0]).toEqual({
            account: 'GACCOUNT',
            fee: 10_000_000,
            syncTimestamp: T,
            timestamp: T,
            network: 'Test SDF Network ; September 2015',
            sorobanRpc: ['http://rpc'],
            newConfig: new Config(nextRaw).getHash(),
            currentConfig: new Config(currentRaw).getHash(),
            buildFee: 10_000_000,
            maxTime: (T + 30_000) / 1000,
            keys: ['account', 'currentConfig', 'fee', 'maxTime', 'network', 'newConfig', 'sorobanRpc', 'timestamp']
        })
        expect(builds[1]).toEqual(builds[0])
        expect(builds[2]).toEqual(builds[0])
    })
})

describe('the config handler hands the pending config expiry to the settings manager', () => {
    test('the expiration date goes beside the envelope, and the envelope keeps none', async () => {
        const settings = installSettings()
        settings.pendingConfig = null

        await new ConfigHandler().handle({}, {data: {currentConfig: echo, pendingConfig: {...heldRaw, expirationDate: T + 90_000}}})

        expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
        const [envelope, nonce, save, expirationDate] = settings.setPendingConfig.mock.calls[0]
        expect(envelope.config.getHash()).toBe(new Config(nextRaw).getHash())
        expect(Object.keys(envelope.toPlainObject())).toEqual(['allowEarlySubmission', 'config', 'signatures', 'timestamp'])
        expect(envelope.expirationDate).toBeUndefined()
        expect(nonce).toBe(2_000) //this node's own vote
        expect(save).toBe(true)
        expect(expirationDate).toBe(T + 90_000)
    })

    test('every CONFIG for the held update passes its expiration date on, or none when the message carries none', async () => {
        const settings = installSettings(T + 90_000)
        const handler = new ConfigHandler()

        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: {...heldRaw, expirationDate: T + 150_000}}})
        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: heldRaw}})
        await handler.handle({}, {data: {currentConfig: echo, pendingConfig: {...heldRaw, expirationDate: 'soon'}}})

        expect(settings.setPendingConfig.mock.calls.map(call => call[3])).toEqual([T + 150_000, undefined, 'soon'])
    })
})
