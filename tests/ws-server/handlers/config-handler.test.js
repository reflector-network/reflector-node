/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const {Config, ConfigEnvelope} = require('@reflector/reflector-shared')
const ChannelTypes = require('../../../src/ws-server/channels/channel-types')

jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 0),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways', CONFIG_FLOOR: 'configFloor'}
}))

const container = require('../../../src/domain/container')
const nonceManager = require('../../../src/ws-server/nonce-manager')
const ConfigHandler = require('../../../src/ws-server/handlers/config-handler')

const nodeKps = [Keypair.random(), Keypair.random(), Keypair.random()]
const [kpA, kpB, kpC] = nodeKps
const outsider = Keypair.random()
//a node set this node has never seen, and the key of the node the forged envelope is aimed at
const outsiderKps = [Keypair.random(), Keypair.random(), Keypair.random()]
const victim = Keypair.random()
const systemAccount = Keypair.random().publicKey()

/**
 * Minimal valid cluster config whose nodes are keypairs this test can sign with
 * @param {Keypair[]} [signers] - node set of the config
 * @param {object} [overrides] - fields merged over the defaults
 * @returns {object} raw config
 */
function rawConfig(signers = nodeKps, overrides = {}) {
    const nodes = {}
    signers.forEach((kp, i) => {
        nodes[kp.publicKey()] = {pubkey: kp.publicKey(), url: `ws://127.0.0.1:300${i}`, domain: `node${i}.example.com`}
    })
    return {
        contracts: {},
        nodes,
        wasmHash: {oracle: 'a'.repeat(64)},
        minDate: 1_700_000_000_000,
        systemAccount,
        network: 'testnet',
        decimals: 14,
        ...overrides
    }
}

/**
 * Signs a raw config the way admin-dashboard does
 * @param {object} raw - raw config
 * @param {Keypair} kp - signer
 * @param {{nonce: number, rejected: boolean}} [options] - signature options
 * @returns {object} raw signature entry
 */
function sign(raw, kp, {nonce = 1_700_000_050_000, rejected = false} = {}) {
    const hash = new Config(raw).getSignaturePayloadHash(kp.publicKey(), nonce, rejected)
    const entry = {pubkey: kp.publicKey(), nonce, signature: Buffer.from(kp.sign(Buffer.from(hash, 'hex'))).toString('hex')}
    if (rejected)
        entry.rejected = true
    return entry
}

/**
 * @param {object} raw - raw config
 * @param {object[]} signatures - raw signature entries
 * @param {number} [timestamp] - scheduled execution time
 * @returns {object} plain envelope as the orchestrator sends it
 */
function envelope(raw, signatures, timestamp = 1_700_000_100_000) {
    return {config: raw, signatures, timestamp, allowEarlySubmission: false}
}

/**
 * @param {object} [options] - settings manager state
 * @returns {object} the mocked settings manager installed on the container
 */
function installSettings({currentConfig = null, pendingConfig = null, self = kpA, clusterConfigHash} = {}) {
    const settingsManager = {
        appConfig: {publicKey: self.publicKey(), clusterConfigHash},
        config: currentConfig,
        pendingConfig,
        //the real SettingsManager.setConfig assigns this.config, and the bootstrap proof depends on it: one CONFIG
        //frame carries both halves, so the pending envelope is verified against whatever the current config installed
        setConfig: jest.fn(config => {
            settingsManager.config = config
        }),
        setPendingConfig: jest.fn(),
        clearPendingConfig: jest.fn(),
        raisePendingConfigFloor: jest.fn(),
        raiseConfigFloor: jest.fn()
    }
    container.settingsManager = settingsManager
    return settingsManager
}

const switchTime = 1_700_000_100_000 //the timestamp envelope() schedules at
const staleClearDelay = 60 * 60 * 1000

let nowSpy = null

/**
 * Pins the local clock the stale-clear rule reads
 * @param {number} now - milliseconds
 */
function setNow(now) {
    nowSpy?.mockRestore()
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
}

afterEach(() => {
    nowSpy?.mockRestore()
    nowSpy = null
})

/**
 * A scheduled update that differs from every current config the tests install. A pending copy of the config a node
 * already runs is dropped on sight, so it cannot stand in for a scheduled update.
 * @returns {ConfigEnvelope} scheduled update
 */
function scheduledUpdate() {
    const raw = rawConfig(nodeKps, {decimals: 17})
    return new ConfigEnvelope(envelope(raw, [sign(raw, kpA)]))
}

describe('ConfigHandler', () => {
    let handler

    beforeEach(() => {
        jest.clearAllMocks()
        nonceManager.getNonce.mockReturnValue(0)
        handler = new ConfigHandler()
    })

    test('declares its channel policy explicitly', () => {
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
        expect(handler.allowAnonymous).toBe(true)
    })

    test('bootstrap: adopts the first config verified against its own node set', async () => {
        const settings = installSettings()
        const raw = rawConfig()
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)])}})

        expect(settings.setConfig).toHaveBeenCalledTimes(1)
        expect(settings.setConfig.mock.calls[0][0].getHash()).toBe(new Config(raw).getHash())
    })

    test('bootstrap: refuses a config signed only by keys this node has never seen [NODE-F-01]', async () => {
        //a fresh node has no current node set, so a majority of the set the envelope itself declares proves nothing.
        //One frame carries both halves: a bootstrap without the guard would install the foreign cluster and verify the
        //pending envelope - which cuts the node set from three to one - against the set it has just installed
        const forgedRaw = rawConfig(outsiderKps)
        const forgedPendingRaw = rawConfig([outsiderKps[0]], {decimals: 15})
        const settings = installSettings({self: victim})
        await handler.handle({}, {
            data: {
                currentConfig: envelope(forgedRaw, [sign(forgedRaw, outsiderKps[0]), sign(forgedRaw, outsiderKps[1])]),
                pendingConfig: envelope(forgedPendingRaw, [sign(forgedPendingRaw, outsiderKps[0]), sign(forgedPendingRaw, outsiderKps[1])])
            }
        })

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.setPendingConfig).not.toHaveBeenCalled()
        expect(settings.config).toBeNull()
    })

    test('bootstrap: adopts that same config once its hash is the operator-pinned clusterConfigHash [NODE-F-01]', async () => {
        const pinnedRaw = rawConfig(outsiderKps)
        const settings = installSettings({self: victim, clusterConfigHash: new Config(pinnedRaw).getHash()})
        await handler.handle({}, {
            data: {currentConfig: envelope(pinnedRaw, [sign(pinnedRaw, outsiderKps[0]), sign(pinnedRaw, outsiderKps[1])])}
        })

        expect(settings.setConfig).toHaveBeenCalledTimes(1)
        expect(settings.setConfig.mock.calls[0][0].getHash()).toBe(new Config(pinnedRaw).getHash())
    })

    test('bootstrap: adopts a config that carries this node own accepting signature [NODE-F-01]', async () => {
        const raw = rawConfig()
        const settings = installSettings({self: kpC})
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpC)])}})

        expect(settings.setConfig).toHaveBeenCalledTimes(1)
    })

    test('bootstrap: refuses the cluster config when this node neither signed it nor pinned its hash [NODE-F-01]', async () => {
        const raw = rawConfig()
        const settings = installSettings({self: kpC})
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)])}})

        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('bootstrap: refuses a config whose hash is not the pinned one [NODE-F-01]', async () => {
        const raw = rawConfig()
        const settings = installSettings({self: kpC, clusterConfigHash: new Config(rawConfig(nodeKps, {decimals: 15})).getHash()})
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)])}})

        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('adopts a config a majority accepted even when this node rejected it and the vote was stripped', async () => {
        const raw = rawConfig()
        const settings = installSettings({currentConfig: new Config(rawConfig(nodeKps, {minDate: 1_600_000_000_000})), self: kpC})
        //the orchestrator strips rejected signatures, so kpC's vote is simply absent
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)])}})

        expect(settings.setConfig).toHaveBeenCalledTimes(1)
        expect(settings.setConfig.mock.calls[0][1]).toBeNull() //no own signature, so the stored nonce is untouched
    })

    test('refuses a config without a majority of the current node set', async () => {
        const raw = rawConfig()
        const settings = installSettings({currentConfig: new Config(rawConfig(nodeKps, {minDate: 1_600_000_000_000}))})
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA)])}})

        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('a signature from outside the node set does not veto adoption and does not count', async () => {
        const raw = rawConfig()
        const settings = installSettings({currentConfig: new Config(rawConfig(nodeKps, {minDate: 1_600_000_000_000}))})
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB), sign(raw, outsider)])}})
        expect(settings.setConfig).toHaveBeenCalledTimes(1)

        settings.setConfig.mockClear()
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, outsider)])}})
        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('persists the nonce of this node own accepting signature and refuses an outdated one', async () => {
        const raw = rawConfig()
        const settings = installSettings({currentConfig: new Config(rawConfig(nodeKps, {minDate: 1_600_000_000_000}))})
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)])}})
        expect(settings.setConfig.mock.calls[0][1]).toBe(1_700_000_050_000)

        settings.setConfig.mockClear()
        nonceManager.getNonce.mockReturnValue(1_700_000_060_000)
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)])}})
        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('an already applied current config is not re-adopted, and a verified message still runs the pending branch', async () => {
        const raw = rawConfig()
        const pendingRaw = rawConfig(nodeKps, {decimals: 15})
        //the current envelope verifies but its hash is the one already applied, so there is nothing to adopt
        const settings = installSettings({currentConfig: new Config(raw)})
        await handler.handle({}, {
            data: {
                currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)]),
                pendingConfig: envelope(pendingRaw, [sign(pendingRaw, kpA), sign(pendingRaw, kpB)])
            }
        })

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
    })

    test('an echo of the applied config that does not verify does not clear the scheduled update within the hour', async () => {
        setNow(switchTime + staleClearDelay)
        const raw = rawConfig()
        const settings = installSettings({
            currentConfig: new Config(raw),
            pendingConfig: scheduledUpdate()
        })
        //the config this node already applied arrives again, with no signature that counts. Being already
        //applied must not be a reason to skip verification: the pending clear below is authorised by that result.
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, outsider)])}})

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.clearPendingConfig).not.toHaveBeenCalled()
    })

    test('an invalid config is not adopted and does not touch the scheduled update', async () => {
        const raw = rawConfig(nodeKps, {systemAccount: 'not-a-key'})
        const settings = installSettings({
            currentConfig: new Config(rawConfig()),
            pendingConfig: scheduledUpdate()
        })
        //an envelope carrying no signatures at all also lands here: the isValid check returns before the verifier is
        //reached, and an empty signature set yields no accepted votes and so could never clear the majority anyway
        await handler.handle({}, {data: {currentConfig: envelope(raw, [])}})

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.clearPendingConfig).not.toHaveBeenCalled()
    })

    test('refuses a pending envelope scheduled before the signed minDate', async () => {
        const raw = rawConfig()
        const pendingRaw = rawConfig(nodeKps, {minDate: 1_700_000_900_000, decimals: 15})
        const settings = installSettings({currentConfig: new Config(raw)})
        await handler.handle({}, {
            data: {
                currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)]),
                pendingConfig: envelope(pendingRaw, [sign(pendingRaw, kpA), sign(pendingRaw, kpB)], 1_700_000_800_000)
            }
        })

        expect(settings.setPendingConfig).not.toHaveBeenCalled()
    })

    test('clears the pending config when a verified message omits it', async () => {
        const raw = rawConfig()
        const settings = installSettings({
            currentConfig: new Config(raw),
            pendingConfig: scheduledUpdate()
        })
        await handler.handle({}, {data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)])}})

        expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
    })

    test('an unverified message never clears the scheduled update', async () => {
        const raw = rawConfig()
        const otherRaw = rawConfig(nodeKps, {decimals: 15})
        const settings = installSettings({
            currentConfig: new Config(raw),
            pendingConfig: scheduledUpdate()
        })
        await handler.handle({}, {data: {currentConfig: envelope(otherRaw, [sign(otherRaw, kpA)])}})

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.clearPendingConfig).not.toHaveBeenCalled()
    })

    test('refuses a superseded config every counted signer signed before the stored nonce [NODE-F-02]', async () => {
        //this node runs V2 and never signed V1, so its own-signature nonce guard does not apply
        const v1 = rawConfig(nodeKps, {decimals: 14})
        const v2 = rawConfig(nodeKps, {decimals: 15})
        const settings = installSettings({currentConfig: new Config(v2), self: kpC})
        nonceManager.getNonce.mockReturnValue(1_799_999_999_999)
        await handler.handle({}, {
            data: {
                currentConfig: envelope(v1, [
                    sign(v1, kpA, {nonce: 1_600_000_050_000}),
                    sign(v1, kpB, {nonce: 1_600_000_050_000})
                ])
            }
        })

        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('adopts a newer config whose counted signatures are not older than the stored nonce [NODE-F-02]', async () => {
        const v2 = rawConfig(nodeKps, {decimals: 15})
        const v3 = rawConfig(nodeKps, {decimals: 16})
        const settings = installSettings({currentConfig: new Config(v2), self: kpC})
        nonceManager.getNonce.mockReturnValue(1_799_999_999_999)
        await handler.handle({}, {
            data: {
                currentConfig: envelope(v3, [
                    sign(v3, kpA, {nonce: 1_800_000_050_000}),
                    sign(v3, kpB, {nonce: 1_800_000_050_000})
                ])
            }
        })

        expect(settings.setConfig).toHaveBeenCalledTimes(1)
    })

    test('a rejection vote neither vetoes adoption nor counts toward the majority', async () => {
        const raw = rawConfig()
        const settings = installSettings({currentConfig: new Config(rawConfig(nodeKps, {decimals: 15})), self: kpC})
        await handler.handle({}, {
            data: {currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB), sign(raw, kpC, {rejected: true})])}
        })

        expect(settings.setConfig).toHaveBeenCalledTimes(1)
        expect(settings.setConfig.mock.calls[0][1]).toBeNull() //a rejection is not this node's accepting signature
    })

    test('rejections never make up the majority', async () => {
        const raw = rawConfig()
        const settings = installSettings({currentConfig: new Config(rawConfig(nodeKps, {decimals: 15}))})
        await handler.handle({}, {
            data: {
                currentConfig: envelope(raw, [
                    sign(raw, kpA),
                    sign(raw, kpB, {rejected: true}),
                    sign(raw, kpC, {rejected: true})
                ])
            }
        })

        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('a malformed signature entry is refused without touching any state', async () => {
        const raw = rawConfig()
        const settings = installSettings({
            currentConfig: new Config(raw),
            pendingConfig: scheduledUpdate()
        })
        const malformed = sign(raw, kpA)
        malformed.signature = 'zz' //7.2.0 throws ValidationError out of the Signature constructor
        await handler.handle({}, {data: {currentConfig: envelope(raw, [malformed])}})

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.clearPendingConfig).not.toHaveBeenCalled()
    })

    test('a malformed pending envelope leaves the scheduled update alone', async () => {
        const raw = rawConfig()
        const pendingRaw = rawConfig(nodeKps, {decimals: 15})
        const settings = installSettings({currentConfig: new Config(raw)})
        const malformed = sign(pendingRaw, kpA)
        malformed.nonce = 0 //a nonce below 1 throws ValidationError out of the Signature constructor
        await handler.handle({}, {
            data: {
                currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)]),
                pendingConfig: envelope(pendingRaw, [malformed])
            }
        })

        expect(settings.setPendingConfig).not.toHaveBeenCalled()
    })

    test('a pending config that fixed no minDate is scheduled as the orchestrator set it', async () => {
        const raw = rawConfig()
        const pendingRaw = rawConfig(nodeKps, {minDate: 0, decimals: 15})
        const settings = installSettings({currentConfig: new Config(raw)})
        await handler.handle({}, {
            data: {
                currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)]),
                pendingConfig: envelope(pendingRaw, [sign(pendingRaw, kpA), sign(pendingRaw, kpB)], 1)
            }
        })

        expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
    })

    test('a refused adoption leaves the scheduled update alone', async () => {
        const raw = rawConfig()
        const pendingRaw = rawConfig(nodeKps, {decimals: 15})
        const settings = installSettings({currentConfig: new Config(rawConfig(nodeKps, {decimals: 13}))})
        //setConfig refuses a validator-set replacement that breaks continuity with the current one
        settings.setConfig.mockImplementation(() => {
            throw new Error('Validators update is not allowed: a majority of the current node set must remain')
        })
        await expect(handler.handle({}, {
            data: {
                currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)]),
                pendingConfig: envelope(pendingRaw, [sign(pendingRaw, kpA), sign(pendingRaw, kpB)])
            }
        })).resolves.toBeUndefined()

        expect(settings.setPendingConfig).not.toHaveBeenCalled()
    })

    test('a scheduling failure is contained and never leaves the handler', async () => {
        const raw = rawConfig()
        const pendingRaw = rawConfig(nodeKps, {decimals: 15})
        const settings = installSettings({currentConfig: new Config(raw)})
        settings.setPendingConfig.mockImplementation(() => {
            throw new Error('Pending config already exists')
        })
        await expect(handler.handle({}, {
            data: {
                currentConfig: envelope(raw, [sign(raw, kpA), sign(raw, kpB)]),
                pendingConfig: envelope(pendingRaw, [sign(pendingRaw, kpA), sign(pendingRaw, kpB)])
            }
        })).resolves.toBeUndefined()
    })

    test('throws when the message carries no data', async () => {
        installSettings()
        await expect(handler.handle({}, {})).rejects.toThrow('Data is required')
    })
})

describe('ConfigHandler after a node-set change', () => {
    const logger = require('../../../src/logger')
    const kps = Array.from({length: 7}, () => Keypair.random())
    const appliedNonce = 1_700_000_050_000
    const nextNonce = 1_700_000_150_000
    //the new node set, and the bare majority of the OLD set that applied the change - the votes the orchestrator echoes
    const changes = {
        //5 -> 6: kps[5] joins, signed by 3 of the old 5
        grow: {newSet: kps.slice(0, 6), voters: [kps[0], kps[1], kps[2]], joiner: kps[5]},
        //7 -> 6: kps[6] leaves, signed by 4 of the old 7 including the node it removes
        shrink: {newSet: kps.slice(0, 6), voters: [kps[6], kps[0], kps[1], kps[2]]}
    }

    /**
     * @param {string} change - key of changes
     * @returns {{appliedRaw: object, appliedSigs: object[], nextRaw: object, nextSigs: object[]}} the applied change
     * with the votes the orchestrator echoes, and the next proposal signed by 4 of the 6 nodes of the new set
     */
    function scenario(change) {
        const {newSet, voters} = changes[change]
        const appliedRaw = rawConfig(newSet, {decimals: 15})
        const nextRaw = rawConfig(newSet, {decimals: 16})
        return {
            appliedRaw,
            appliedSigs: voters.map(kp => sign(appliedRaw, kp, {nonce: appliedNonce})),
            nextRaw,
            nextSigs: newSet.slice(0, 4).map(kp => sign(nextRaw, kp, {nonce: nextNonce}))
        }
    }

    /**
     * installSettings with the pending-config bookkeeping of the real SettingsManager
     * @param {object} options - see installSettings
     * @returns {object} the mocked settings manager
     */
    function installTrackingSettings(options) {
        const settings = installSettings(options)
        settings.setPendingConfig.mockImplementation(pending => {
            if (settings.pendingConfig && settings.pendingConfig.config.getHash() !== pending.config.getHash())
                throw new Error('Pending config already exists')
            settings.pendingConfig = pending
        })
        settings.clearPendingConfig.mockImplementation(() => {
            settings.pendingConfig = null
        })
        return settings
    }

    let handler

    beforeEach(() => {
        jest.clearAllMocks()
        nonceManager.getNonce.mockReturnValue(0)
        handler = new ConfigHandler()
    })

    test.each([
        ['grow', 'a voter of the change', 0],
        ['grow', 'a node that did not vote on the change', 3],
        ['shrink', 'a voter of the change', 0],
        ['shrink', 'a node that did not vote on the change', 3]
    ])('%s: %s schedules the next proposal although the echo of the change no longer verifies', async (change, _, selfIndex) => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario(change)
        const settings = installTrackingSettings({currentConfig: new Config(appliedRaw), self: kps[selfIndex]})
        await handler.handle({}, {
            data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs)}
        })

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
        expect(settings.setPendingConfig.mock.calls[0][0].config.getHash()).toBe(new Config(nextRaw).getHash())
        expect(settings.setPendingConfig.mock.calls[0][1]).toBe(nextNonce) //both nodes signed the next proposal
        //the echo counts 3 of the 6 current nodes, one short of the 4 a majority needs
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Config envelope has no majority of the current node set',
            hash: new Config(appliedRaw).getHash(),
            accepted: 3,
            required: 4,
            nodes: 6
        }))
    })

    test('the next proposal is still verified against the current node set on its own', async () => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const settings = installTrackingSettings({currentConfig: new Config(appliedRaw), self: kps[3]})
        await handler.handle({}, {
            data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs.slice(0, 3))}
        })

        expect(settings.setPendingConfig).not.toHaveBeenCalled()
    })

    test('the next proposal is refused when every counted signature predates the stored pending nonce', async () => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const settings = installTrackingSettings({currentConfig: new Config(appliedRaw), self: kps[3]})
        nonceManager.getNonce.mockImplementation(type => (type === nonceManager.nonceTypes.PENDING_CONFIG ? nextNonce + 1 : 0))
        await handler.handle({}, {
            data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs)}
        })

        expect(settings.setPendingConfig).not.toHaveBeenCalled()
    })

    test('a replayed config from before the change is refused, and so is the pending envelope it carries', async () => {
        const {appliedRaw, nextRaw, nextSigs} = scenario('grow')
        const oldRaw = rawConfig(kps.slice(0, 5), {decimals: 14})
        const settings = installTrackingSettings({currentConfig: new Config(appliedRaw), self: kps[3]})
        await handler.handle({}, {
            data: {
                currentConfig: envelope(oldRaw, kps.slice(0, 3).map(kp => sign(oldRaw, kp, {nonce: 1_600_000_050_000}))),
                pendingConfig: envelope(nextRaw, nextSigs)
            }
        })

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.setPendingConfig).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Refusing the current config',
            receivedHash: new Config(oldRaw).getHash(),
            heldHash: new Config(appliedRaw).getHash()
        }))
    })

    test('an echo that does not verify does not clear a scheduled update within the hour after its switch time', async () => {
        setNow(switchTime + staleClearDelay)
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const scheduled = new ConfigEnvelope(envelope(nextRaw, nextSigs))
        const settings = installTrackingSettings({currentConfig: new Config(appliedRaw), pendingConfig: scheduled, self: kps[3]})
        await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs)}})

        expect(settings.clearPendingConfig).not.toHaveBeenCalled()
        expect(settings.pendingConfig).toBe(scheduled)
    })

    test('an update the echo cannot clear is dropped once it is an hour past its switch time', async () => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const scheduled = new ConfigEnvelope(envelope(nextRaw, nextSigs))
        const settings = installTrackingSettings({currentConfig: new Config(appliedRaw), pendingConfig: scheduled, self: kps[3]})

        setNow(switchTime + staleClearDelay)
        await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs)}})
        expect(settings.pendingConfig).toBe(scheduled)

        setNow(switchTime + staleClearDelay + 1)
        await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs)}})

        expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        expect(settings.pendingConfig).toBeNull()
        expect(settings.setConfig).not.toHaveBeenCalled() //liveness only: nothing is adopted
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            msg: expect.stringContaining('an hour past its switch time'),
            hash: new Config(nextRaw).getHash(),
            timestamp: switchTime
        }))
    })

    test('an echo that verifies still clears a held update at once', async () => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const settings = installTrackingSettings({
            currentConfig: new Config(appliedRaw),
            pendingConfig: new ConfigEnvelope(envelope(nextRaw, nextSigs)),
            self: kps[3]
        })
        setNow(switchTime + 60_000)
        const toppedUp = [...appliedSigs, sign(appliedRaw, kps[3], {nonce: appliedNonce})] //4 of 6 now

        await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, toppedUp)}})

        expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        expect(settings.pendingConfig).toBeNull()
    })

    test('a pending copy of the config this node already runs is dropped, and the next proposal is scheduled', async () => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const settings = installTrackingSettings({
            currentConfig: new Config(appliedRaw),
            pendingConfig: new ConfigEnvelope(envelope(appliedRaw, appliedSigs)),
            self: kps[3]
        })
        await handler.handle({}, {
            data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs)}
        })

        expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
        expect(settings.pendingConfig.config.getHash()).toBe(new Config(nextRaw).getHash())
    })

    test('a pending copy of the config this node already runs is dropped when no pending config is sent', async () => {
        const {appliedRaw, appliedSigs} = scenario('shrink')
        const settings = installTrackingSettings({
            currentConfig: new Config(appliedRaw),
            pendingConfig: new ConfigEnvelope(envelope(appliedRaw, appliedSigs)),
            self: kps[3]
        })
        await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs)}})

        expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        expect(settings.pendingConfig).toBeNull()
    })

    test('a joining node whose clusterConfigHash is the grown config adopts it and schedules the next proposal', async () => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const settings = installTrackingSettings({self: changes.grow.joiner, clusterConfigHash: new Config(appliedRaw).getHash()})
        await handler.handle({}, {
            data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs)}
        })

        expect(settings.setConfig).toHaveBeenCalledTimes(1)
        expect(settings.setConfig.mock.calls[0][0].getHash()).toBe(new Config(appliedRaw).getHash())
        expect(settings.setConfig.mock.calls[0][1]).toBeNull() //the joiner never signed the config that admits it
        expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
        expect(settings.setPendingConfig.mock.calls[0][0].config.getHash()).toBe(new Config(nextRaw).getHash())
    })

    test.each([
        ['a wrong', () => new Config(rawConfig(kps.slice(0, 6), {decimals: 13})).getHash()],
        ['no', () => undefined]
    ])('a joining node with %s clusterConfigHash and no signature of its own refuses the grown config', async (_, anchor) => {
        const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
        const settings = installTrackingSettings({self: changes.grow.joiner, clusterConfigHash: anchor()})
        await handler.handle({}, {
            data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs)}
        })

        expect(settings.setConfig).not.toHaveBeenCalled()
        expect(settings.setPendingConfig).not.toHaveBeenCalled()
        expect(settings.config).toBeNull()
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
            receivedHash: new Config(appliedRaw).getHash(),
            configuredHash: anchor() || null
        }))
    })

    test('the clusterConfigHash anchor authorises the first adoption only, never a later one', async () => {
        //the operator left the anchor pinned to the config the node joined with; the cluster has moved on since
        const {appliedRaw, appliedSigs, nextRaw} = scenario('grow')
        const settings = installTrackingSettings({
            currentConfig: new Config(nextRaw),
            self: changes.grow.joiner,
            clusterConfigHash: new Config(appliedRaw).getHash()
        })
        await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs)}})

        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    test('a joining node with the matching clusterConfigHash still refuses a config older than its stored nonce', async () => {
        const {appliedRaw, appliedSigs} = scenario('grow')
        const settings = installTrackingSettings({self: changes.grow.joiner, clusterConfigHash: new Config(appliedRaw).getHash()})
        nonceManager.getNonce.mockImplementation(type => (type === nonceManager.nonceTypes.CONFIG ? appliedNonce + 1 : 0))
        await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs)}})

        expect(settings.setConfig).not.toHaveBeenCalled()
    })

    describe('nonce floors, with the nonces persisted', () => {
        /**
         * An entry under the given key whose signature bytes are garbage, carrying the largest nonce a Signature accepts
         * @param {Keypair} kp - key the entry claims to come from
         * @returns {object} raw signature entry
         */
        function forgedEntry(kp) {
            return {pubkey: kp.publicKey(), nonce: Number.MAX_SAFE_INTEGER, signature: 'ab'.repeat(64)}
        }

        /**
         * Wires the settings mock and the nonce mock to one store, the way SettingsManager persists to .nonce.json
         * @param {object} options - see installSettings
         * @returns {{settings: object, nonces: Object.<string, number>}}
         */
        function installWithNonces(options) {
            const nonces = {}
            const settings = installTrackingSettings(options)
            const {setConfig, setPendingConfig, raisePendingConfigFloor, raiseConfigFloor} = settings
            const persistConfig = setConfig.getMockImplementation()
            const persistPending = setPendingConfig.getMockImplementation()
            //the real SettingsManager.raisePendingConfigFloor only ever raises
            raisePendingConfigFloor.mockImplementation(nonce => {
                if (nonce > (nonces[nonceManager.nonceTypes.PENDING_CONFIG] || 0))
                    nonces[nonceManager.nonceTypes.PENDING_CONFIG] = nonce
            })
            //the real SettingsManager.raiseConfigFloor only ever raises
            raiseConfigFloor.mockImplementation(nonce => {
                if (nonce > (nonces[nonceManager.nonceTypes.CONFIG_FLOOR] || 0))
                    nonces[nonceManager.nonceTypes.CONFIG_FLOOR] = nonce
            })
            setConfig.mockImplementation((config, nonce) => {
                persistConfig(config, nonce)
                if (nonce)
                    nonces[nonceManager.nonceTypes.CONFIG] = nonce
            })
            setPendingConfig.mockImplementation((pending, nonce) => {
                persistPending(pending, nonce)
                if (nonce)
                    nonces[nonceManager.nonceTypes.PENDING_CONFIG] = nonce
            })
            nonceManager.getNonce.mockImplementation(type => nonces[type] || 0)
            return {settings, nonces}
        }

        test('a verified pending envelope does not lend its forged own-key nonce, and the next proposal still schedules', async () => {
            const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
            const self = kps[4] //did not sign the next proposal
            const {settings, nonces} = installWithNonces({currentConfig: new Config(appliedRaw), self})
            await handler.handle({}, {
                data: {
                    currentConfig: envelope(appliedRaw, appliedSigs),
                    pendingConfig: envelope(nextRaw, [...nextSigs, forgedEntry(self)])
                }
            })

            expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
            expect(settings.setPendingConfig.mock.calls[0][1]).toBeNull()
            expect(nonces[nonceManager.nonceTypes.PENDING_CONFIG]).toBeUndefined()

            //the update lands, the runner copies the PENDING_CONFIG nonce into CONFIG and clears it, and the cluster
            //votes on the proposal after it
            nonces[nonceManager.nonceTypes.CONFIG] = nonces[nonceManager.nonceTypes.PENDING_CONFIG]
            settings.config = new Config(nextRaw)
            settings.pendingConfig = null
            const laterRaw = rawConfig(changes.grow.newSet, {decimals: 17})
            const laterNonce = nextNonce + 100_000
            await handler.handle({}, {
                data: {
                    currentConfig: envelope(nextRaw, nextSigs),
                    pendingConfig: envelope(laterRaw, changes.grow.newSet.slice(0, 4).map(kp => sign(laterRaw, kp, {nonce: laterNonce})))
                }
            })

            expect(settings.setPendingConfig).toHaveBeenCalledTimes(2)
            expect(settings.pendingConfig.config.getHash()).toBe(new Config(laterRaw).getHash())
        })

        test('a proposal signed before the change this node adopted is refused although this node never voted on the change', async () => {
            //P1 was signed by 4 of the old 5, this node among them, and never landed; the grow was then applied by 3 of
            //the old 5 without this node. Its floor is still its own P1 vote
            const oldSet = kps.slice(0, 5)
            const self = kps[3]
            const p1Raw = rawConfig(oldSet, {decimals: 13})
            const p1Nonce = 1_600_000_050_000
            const p1Sigs = [kps[0], kps[1], kps[2], kps[3]].map(kp => sign(p1Raw, kp, {nonce: p1Nonce}))
            const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
            const {settings, nonces} = installWithNonces({currentConfig: new Config(rawConfig(oldSet)), self})
            nonces[nonceManager.nonceTypes.PENDING_CONFIG] = p1Nonce

            //offline across the grow: the echo is adopted directly
            await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs)}})
            expect(settings.config.getHash()).toBe(new Config(appliedRaw).getHash())
            expect(nonces[nonceManager.nonceTypes.PENDING_CONFIG]).toBe(appliedNonce)

            //P1 counts 4 of the new 6, a majority, but every one of its votes predates the grow
            await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(p1Raw, p1Sigs)}})
            expect(settings.setPendingConfig).not.toHaveBeenCalled()

            //the proposal the cluster votes on after the grow still schedules
            await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs)}})
            expect(settings.setPendingConfig).toHaveBeenCalledTimes(1)
            expect(settings.pendingConfig.config.getHash()).toBe(new Config(nextRaw).getHash())
        })

        test('an anchored joiner does not store a forged own-key nonce, and a verified echo can still clear its update', async () => {
            const {appliedRaw, appliedSigs, nextRaw, nextSigs} = scenario('grow')
            const {joiner} = changes.grow
            const {settings, nonces} = installWithNonces({self: joiner, clusterConfigHash: new Config(appliedRaw).getHash()})
            //the anchored envelope needs no valid signature at all, so a forged own entry is all it carries
            await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, [forgedEntry(joiner)])}})

            expect(settings.setConfig).toHaveBeenCalledTimes(1)
            expect(settings.setConfig.mock.calls[0][1]).toBeNull()
            expect(nonces[nonceManager.nonceTypes.CONFIG]).toBeUndefined()

            //an update is scheduled, then the orchestrator drops it with a CONFIG message whose echo verifies
            await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, appliedSigs), pendingConfig: envelope(nextRaw, nextSigs)}})
            expect(settings.pendingConfig.config.getHash()).toBe(new Config(nextRaw).getHash())
            const toppedUp = [...appliedSigs, sign(appliedRaw, kps[3], {nonce: appliedNonce})] //4 of 6 now
            await handler.handle({}, {data: {currentConfig: envelope(appliedRaw, toppedUp)}})

            expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
            expect(settings.pendingConfig).toBeNull()
        })

        test('a config signed before the one this node adopted is refused, although this node voted on neither', async () => {
            const newSet = changes.grow.newSet
            const olderRaw = rawConfig(newSet, {decimals: 20})
            const newerRaw = rawConfig(newSet, {decimals: 21})
            const voters = newSet.slice(0, 4) //a majority of the six
            const {settings, nonces} = installWithNonces({currentConfig: new Config(olderRaw), self: kps[5]})
            const newerSignatures = voters.map(kp => sign(newerRaw, kp, {nonce: nextNonce}))

            await handler.handle({}, {data: {currentConfig: envelope(newerRaw, newerSignatures)}})
            expect(settings.setConfig).toHaveBeenCalledTimes(1)
            expect(nonces[nonceManager.nonceTypes.CONFIG_FLOOR]).toBe(nextNonce)

            //whoever holds the orchestrator channel replays the older config, which a majority signed as well
            const replayedSignatures = voters.map(kp => sign(olderRaw, kp, {nonce: appliedNonce}))
            await handler.handle({}, {data: {currentConfig: envelope(olderRaw, replayedSignatures)}})

            expect(settings.setConfig).toHaveBeenCalledTimes(1)
            expect(settings.config.getHash()).toBe(new Config(newerRaw).getHash())
            expect(nonces[nonceManager.nonceTypes.CONFIG]).toBeUndefined() //this node's own votes: none
        })

        test('the echo of the adopted config still verifies against the raised floor', async () => {
            const newSet = changes.grow.newSet
            const olderRaw = rawConfig(newSet, {decimals: 22})
            const newerRaw = rawConfig(newSet, {decimals: 23})
            const signatures = newSet.slice(0, 4).map((kp, i) => sign(newerRaw, kp, {nonce: nextNonce + i}))
            const scheduledRaw = rawConfig(newSet, {decimals: 24})
            const {settings} = installWithNonces({currentConfig: new Config(olderRaw), self: kps[5]})
            await handler.handle({}, {data: {currentConfig: envelope(newerRaw, signatures)}})
            const scheduledSignatures = newSet.slice(0, 4).map(kp => sign(scheduledRaw, kp, {nonce: nextNonce + 10}))
            settings.pendingConfig = new ConfigEnvelope(envelope(scheduledRaw, scheduledSignatures))

            //a verified echo without a pending config clears the scheduled update: the echo must still verify
            await handler.handle({}, {data: {currentConfig: envelope(newerRaw, signatures)}})

            expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        })

        test('the echo still verifies after the change removed the signer with the latest nonce: the floor is the lowest counted nonce', async () => {
            const oldSet = kps.slice(0, 7)
            const newSet = kps.slice(0, 6) //kps[6] leaves
            const shrinkRaw = rawConfig(newSet, {decimals: 26})
            //5 of the old 7; the node the change removes signed last
            const shrinkSignatures = newSet.slice(0, 4).map((kp, i) => sign(shrinkRaw, kp, {nonce: nextNonce + i}))
            shrinkSignatures.push(sign(shrinkRaw, kps[6], {nonce: nextNonce + 50}))
            const {settings, nonces} = installWithNonces({currentConfig: new Config(rawConfig(oldSet, {decimals: 25})), self: kps[5]})
            await handler.handle({}, {data: {currentConfig: envelope(shrinkRaw, shrinkSignatures)}})
            expect(settings.setConfig).toHaveBeenCalledTimes(1)
            expect(nonces[nonceManager.nonceTypes.CONFIG_FLOOR]).toBe(nextNonce)

            const scheduledRaw = rawConfig(newSet, {decimals: 27})
            const scheduledSignatures = newSet.slice(0, 4).map(kp => sign(scheduledRaw, kp, {nonce: nextNonce + 100}))
            settings.pendingConfig = new ConfigEnvelope(envelope(scheduledRaw, scheduledSignatures))
            //counted against the six now: 4 of 6, whose latest nonce is below the removed signer's
            await handler.handle({}, {data: {currentConfig: envelope(shrinkRaw, shrinkSignatures)}})

            expect(settings.clearPendingConfig).toHaveBeenCalledTimes(1)
        })

        test('a signature that did not count does not lower the floor', async () => {
            const newSet = changes.grow.newSet
            const olderRaw = rawConfig(newSet, {decimals: 28})
            const newerRaw = rawConfig(newSet, {decimals: 29})
            const newerSignatures = newSet.slice(0, 4).map(kp => sign(newerRaw, kp, {nonce: nextNonce}))
            newerSignatures.push(sign(newerRaw, outsider, {nonce: appliedNonce - 1})) //does not count, and is the lowest
            const {settings, nonces} = installWithNonces({currentConfig: new Config(olderRaw), self: kps[5]})

            await handler.handle({}, {data: {currentConfig: envelope(newerRaw, newerSignatures)}})

            expect(settings.setConfig).toHaveBeenCalledTimes(1)
            expect(nonces[nonceManager.nonceTypes.CONFIG_FLOOR]).toBe(nextNonce)
        })

        test('a newer config this node signed with a clock behind the raised floor is still adopted', async () => {
            //this node adopted C1 from the echo without voting, so its CONFIG floor is C1's lowest counted nonce, and its
            //own CONFIG nonce is still 0. The operator then signs C2 on a browser clock that lags the peers who signed C1:
            //the own-signature guard compares with this node's own votes, never with the floor, or the node would refuse
            //every config its operator signs until the clock catches up
            const newSet = changes.grow.newSet
            const self = kps[5]
            const c1Raw = rawConfig(newSet, {decimals: 30})
            const c2Raw = rawConfig(newSet, {decimals: 31})
            const {settings, nonces} = installWithNonces({currentConfig: new Config(rawConfig(newSet, {decimals: 29})), self})
            const c1Signatures = newSet.slice(0, 4).map(kp => sign(c1Raw, kp, {nonce: 1_000}))
            await handler.handle({}, {data: {currentConfig: envelope(c1Raw, c1Signatures)}})
            expect(nonces[nonceManager.nonceTypes.CONFIG_FLOOR]).toBe(1_000)
            expect(nonces[nonceManager.nonceTypes.CONFIG]).toBeUndefined()

            const c2Signatures = [0, 1, 2].map(i => sign(c2Raw, kps[i], {nonce: 2_000 + i}))
            c2Signatures.push(sign(c2Raw, self, {nonce: 900})) //this node's own vote, on a lagging clock
            await handler.handle({}, {data: {currentConfig: envelope(c2Raw, c2Signatures)}})

            expect(settings.setConfig).toHaveBeenCalledTimes(2)
            expect(settings.config.getHash()).toBe(new Config(c2Raw).getHash())
            expect(nonces[nonceManager.nonceTypes.CONFIG]).toBe(900) //its own vote is recorded as it was cast
        })

        test('the CONFIG nonce of an adopted config is its lowest counted nonce, not this node\'s later top-up, and never moves down', async () => {
            const newSet = changes.grow.newSet
            const self = kps[5]
            const c1Raw = rawConfig(newSet, {decimals: 34})
            const c2Raw = rawConfig(newSet, {decimals: 35})
            const {settings, nonces} = installWithNonces({currentConfig: new Config(rawConfig(newSet, {decimals: 33})), self})
            //this node's own signature on C1 is a top-up made well after the others signed
            const c1Signatures = [0, 1, 2].map(i => sign(c1Raw, kps[i], {nonce: 5_000 + i}))
            c1Signatures.push(sign(c1Raw, self, {nonce: 9_000}))
            await handler.handle({}, {data: {currentConfig: envelope(c1Raw, c1Signatures)}})
            expect(settings.config.getHash()).toBe(new Config(c1Raw).getHash())
            expect(nonces[nonceManager.nonceTypes.CONFIG]).toBe(5_000)

            //C2's lowest counted nonce (4 000, a lagging clock) is below the stored 5 000, which stays. With 4 of 6
            //counted, only 3 are at or after the CONFIG floor (5 000), no majority: refused until another vote arrives
            const c2Signatures = [[0, 4_000], [1, 6_000], [2, 6_100]].map(([i, nonce]) => sign(c2Raw, kps[i], {nonce}))
            c2Signatures.push(sign(c2Raw, self, {nonce: 6_200}))
            await handler.handle({}, {data: {currentConfig: envelope(c2Raw, c2Signatures)}})
            expect(settings.config.getHash()).toBe(new Config(c1Raw).getHash())
            expect(logger.error).toHaveBeenCalledWith({
                msg: 'Config envelope is superseded: fewer than a majority of the current node set signed after the config this node adopted',
                nonceType: nonceManager.nonceTypes.CONFIG,
                fresh: 3,
                required: 4,
                configFloor: 5_000
            })

            c2Signatures.push(sign(c2Raw, kps[3], {nonce: 6_300}))
            await handler.handle({}, {data: {currentConfig: envelope(c2Raw, c2Signatures)}})
            expect(settings.config.getHash()).toBe(new Config(c2Raw).getHash())
            expect(nonces[nonceManager.nonceTypes.CONFIG]).toBe(5_000)
        })

        test('the floors are stored before the adopted config is written: a failure in between keeps them, and the re-sent echo still adopts', async () => {
            const newSet = changes.grow.newSet
            const olderRaw = rawConfig(newSet, {decimals: 32})
            const newerRaw = rawConfig(newSet, {decimals: 33})
            const signatures = newSet.slice(0, 4).map((kp, i) => sign(newerRaw, kp, {nonce: nextNonce + i}))
            const {settings, nonces} = installWithNonces({currentConfig: new Config(olderRaw), self: kps[5]})
            settings.setConfig.mockImplementationOnce(() => Promise.reject(new Error('ENOSPC: no space left on device')))

            await handler.handle({}, {data: {currentConfig: envelope(newerRaw, signatures)}})

            expect(settings.config.getHash()).toBe(new Config(olderRaw).getHash())
            expect(nonces[nonceManager.nonceTypes.PENDING_CONFIG]).toBe(nextNonce) //the lowest counted nonce
            expect(nonces[nonceManager.nonceTypes.CONFIG_FLOOR]).toBe(nextNonce)

            //the orchestrator echoes the same config again, and this time it is written
            await handler.handle({}, {data: {currentConfig: envelope(newerRaw, signatures)}})

            expect(settings.config.getHash()).toBe(new Config(newerRaw).getHash())
        })
    })
})
