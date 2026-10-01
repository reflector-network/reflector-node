const fs = require('fs')
const {createHash} = require('crypto')
const {ValidationError, ConfigEnvelope, buildUpdates, Config, ContractTypes, getDataHash, isAllowedValidatorsUpdate} = require('@reflector/reflector-shared')
const AppConfig = require('../models/app-config')
const logger = require('../logger')
const {importRSAKey, randomUUID} = require('../utils/crypto-helper')
const nonceManager = require('../ws-server/nonce-manager')
const {isDebugging} = require('../utils')
const {validateGatewayUrl, maxGatewayUrls} = require('../utils/ssrf-validator')
const {writeFileAtomic} = require('../utils/fs-helper')
const runnerManager = require('./runners/runner-manager')
const nodesManager = require('./nodes/nodes-manager')
const container = require('./container')
const dataSourceManager = require('./data-sources-manager')
const statisticsManager = require('./statistics-manager')
const {defaultDecimals, defaultBaseAssets} = require('./default-values')

const appConfigPath = `${container.homeDir}/app.config.json`
const gatewaysPath = `${container.homeDir}/gateways.json`
const clusterConfigPath = `${container.homeDir}/.config.json`
const clusterPendingConfigPath = `${container.homeDir}/.pending.config.json`
//runtime state that is not configuration: the trace toggle. It holds nothing secret
const statePath = `${container.homeDir}/.state.json`

/**
 * @typedef {import('@reflector/reflector-shared').Node} Node
 * @typedef {import('@reflector/reflector-shared').OracleConfig} OracleConfig
 * @typedef {import('@reflector/reflector-shared').SubscriptionsConfig} SubscriptionsConfig
 * @typedef {import('@reflector/reflector-shared').DAOConfig} DAOConfig
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

/**
 * @param {Config} config - config
 * @param {string} contractId - contract id
 * @returns {OracleConfig|SubscriptionsConfig}
 */
function __getContractConfig(config, contractId) {
    const contractConfig = config.contracts.get(contractId)
    if (!contractConfig)
        throw new ValidationError(`Contract ${contractId} not found`)
    return contractConfig
}

/**
 * @param {Config} config - config
 * @param {string} contractId - contract id
 * @param {string} [type] - contract type
 * @returns {boolean}
 */
function __hasContractConfig(config, contractId, type = null) {
    const contractConfig = config.contracts.get(contractId)
    if (!contractConfig || (type && contractConfig.type !== type))
        return false
    return true
}

/**
 * Lowest nonce among the signatures of an envelope that verify against a node set, rejections excluded. Unknown and
 * invalid entries do not count, so a forged entry cannot move the result
 * @param {ConfigEnvelope} envelope - envelope
 * @param {string[]} nodes - node set the envelope was voted on
 * @returns {number} lowest counted nonce, 0 when nothing counted
 */
function getLowestCountedNonce(envelope, nodes) {
    if (!nodes.length)
        return 0
    const {accepted} = envelope.verifySignatures(nodes)
    const nonces = envelope.signatures.filter(s => !s.rejected && accepted.includes(s.pubkey)).map(s => s.nonce)
    return nonces.length ? Math.min(...nonces) : 0
}

/**
 * A gateways.json whose list is empty or missing is "no gateways configured" whatever its challenge says: nothing could
 * be routed through it, so it cannot be a configuration that failed. Such a file gets a fresh challenge, as a first boot
 * does, rather than being refused and read as configured-but-none-usable. Only a non-empty list can fail.
 * @param {any} gatewaysData - parsed gateways.json
 * @returns {any} the data to apply
 */
function withChallengeWhenUnconfigured(gatewaysData) {
    if (!gatewaysData || typeof gatewaysData !== 'object' || Array.isArray(gatewaysData))
        return gatewaysData //not a gateways object at all; setGateways refuses it
    const {urls, challenge} = gatewaysData
    const unconfigured = urls === undefined || urls === null || (Array.isArray(urls) && urls.length === 0)
    if (!unconfigured || (typeof challenge === 'string' && challenge))
        return gatewaysData
    return {urls: [], challenge: randomUUID()}
}

/**
 * @param {string} gatewayValidationKey - the node's gateway token
 * @returns {string} a short, non-reversible identifier of the token, safe to log
 */
function getKeyFingerprint(gatewayValidationKey) {
    return createHash('sha256').update(gatewayValidationKey).digest('hex').slice(0, 8)
}

class SettingsManager {
    /**
     * @type {AppConfig}
     */
    appConfig

    /**
     * @type {ConfigEnvelope}
     */
    pendingConfig

    /**
     * Expiration date of the pending config, milliseconds, as node-orchestrator sends it beside the envelope; null when
     * it sent none. Unsigned metadata: the cluster runner uses it only to skip a round that would end after it,
     * and it never reaches a payload
     * @type {number|null}
     */
    pendingExpirationDate = null

    /**
     * @type {Config}
     */
    config

    /**
     * Always an object once init has run. `urls` is the routing set in one of three states - see setGateways;
     * `configuredUrls` is the list as pushed or read from disk, which is what is persisted and reported back
     * @type {{urls: string[]|null, configuredUrls: string[], challenge: string, gatewayValidationKey: string}}
     */
    gateways

    /**
     * @type {import('crypto').KeyObject}
     */
    clusterSecretObject = null

    async init() {
        this.__restrictHomeDir()
        //set app config
        if (!fs.existsSync(appConfigPath))
            throw new Error('Config file not found')
        const rawAppConfig = JSON.parse(fs.readFileSync(appConfigPath).toString().trim())
        this.appConfig = new AppConfig(rawAppConfig)
        if (!this.appConfig.isValid) {
            //shutdown the app if app config is invalid
            throw new Error(`Invalid app config. Issues: ${this.appConfig.issuesString}`)
        }
        this.__applyStoredTrace()
        await this.setAppConfig(this.appConfig)

        //set gateways. Only a missing file means "no gateways configured": a gateways.json that exists belongs to a
        //node that configured gateways, so a file this node cannot use fails closed instead of going direct
        const gatewaysExist = fs.existsSync(gatewaysPath)
        if (!gatewaysExist) {
            //first boot: nothing is configured, so the direct route is the only one there is
            this.setGateways({urls: [], challenge: randomUUID()}, true)
        } else {
            try {
                this.setGateways(withChallengeWhenUnconfigured(JSON.parse(fs.readFileSync(gatewaysPath).toString().trim())), false)
            } catch (err) {
                //a JSON.parse message quotes the text around the error, which can be part of a gateway url and its token
                const reason = err instanceof SyntaxError ? 'not valid JSON' : err.message
                logger.error({msg: 'gateways.json cannot be used; webhook posts and gateway price fetches fail closed until it is repaired', err: reason})
                //configured but none usable, and the file is left exactly as it is for the operator to repair - it is never
                //rewritten as "no gateways", which would send webhooks and price fetches direct on the next boot. The
                //state is installed directly: run through validation, the placeholder entry would log a second error
                //naming an empty url the file does not contain
                this.__applyGateways([], [''], randomUUID(), false)
            }
        }

        //set current config
        const rawConfig = fs.existsSync(clusterConfigPath)
            ? JSON.parse(fs.readFileSync(clusterConfigPath).toString().trim())
            : null
        if (rawConfig) {
            const clusterConfig = new Config(rawConfig)
            //a node that has a stored config must never continue without it: with no config loaded the config handler
            //has nothing but the incoming envelope's own node set to verify the first config against, and a node that
            //has already joined a cluster must not fall back into that state unnoticed
            if (!clusterConfig.isValid)
                throw new Error(`Invalid cluster config ${clusterConfigPath}. Issues: ${clusterConfig.issuesString}`)
            await this.setConfig(clusterConfig, null, false)
        }
        //set pending updates
        this.__loadPendingConfig()
    }

    /**
     * The home directory holds the node seed, the cluster RSA key and the nonces, and nobody but the node's own user
     * needs to list or read it. A home the process may not chmod - a mount owned by another user - is
     * reported, not fatal
     */
    //eslint-disable-next-line class-methods-use-this
    __restrictHomeDir() {
        try {
            fs.chmodSync(container.homeDir, 0o700)
        } catch (err) {
            logger.warn({msg: 'Cannot restrict the home directory to its owner', err: err.message})
        }
    }

    /**
     * Loads the stored pending update. Unlike the current config, a pending update is re-sent by the orchestrator while it
     * is still open and is verified again on arrival, so one that cannot be used is set aside and the node boots. The
     * two cases set aside: a torn file, and a pending config equal to the current
     * one, left when the process stopped between writing the applied config and removing the pending file
     */
    __loadPendingConfig() {
        if (!fs.existsSync(clusterPendingConfigPath))
            return
        let clusterPendingConfig = null
        let rawPending = null
        try {
            rawPending = JSON.parse(fs.readFileSync(clusterPendingConfigPath).toString().trim())
            clusterPendingConfig = new ConfigEnvelope(rawPending)
            if (!clusterPendingConfig.config.isValid)
                throw new Error(`Invalid pending config. Issues: ${clusterPendingConfig.config.issuesString}`)
        } catch (err) {
            this.__setPendingConfigAside(err)
            return
        }
        if (this.config && clusterPendingConfig.config.getHash() === this.config.getHash()) {
            //the process stopped after setConfig and before the rest of applyPendingUpdate, so the floor it raises is
            //raised here. The node set that voted is gone; the signers are counted against the adopted
            //set, the closest set this node holds, and the floor stays capped at the node clock. The floor is raised
            //before the file is removed and a failure stops the boot, so a floor that could not be stored is raised
            //again on the next boot rather than lost with the file
            const nodes = [...this.config.nodes.keys()]
            const lowestNonce = getLowestCountedNonce(clusterPendingConfig, nodes)
            logger.info({msg: 'The stored pending config is the config this node already runs; removing it'})
            this.raisePendingConfigFloor(lowestNonce)
            this.raiseConfigFloor(lowestNonce)
            this.clearPendingConfig()
            return
        }
        try {
            //the expiration date is stored beside the envelope (setPendingConfig) and validated again here
            this.setPendingConfig(clusterPendingConfig, null, false, rawPending.expirationDate)
        } catch (err) {
            this.__setPendingConfigAside(err)
        }
    }

    /**
     * Moves an unusable stored pending update aside, byte for byte, for the operator to inspect
     * @param {Error} err - why it cannot be used
     */
    __setPendingConfigAside(err) {
        //a JSON.parse message quotes the text around the error, which is config content
        const reason = err instanceof SyntaxError ? 'not valid JSON' : err.message
        logger.error({msg: 'The stored pending config cannot be used; it is moved aside to .pending.config.json.corrupt, and the orchestrator re-sends an update that is still pending', err: reason})
        this.pendingConfig = null
        this.pendingExpirationDate = null
        fs.renameSync(clusterPendingConfigPath, `${clusterPendingConfigPath}.corrupt`)
    }

    /**
     * Applies the trace toggle and stores it in the state file. app.config.json holds the node seed and is never
     * rewritten by the node
     * @param {boolean} trace - whether trace logging is on
     */
    setTrace(trace) {
        this.appConfig.trace = !!trace
        logger.setTrace(this.appConfig.trace)
        writeFileAtomic(statePath, JSON.stringify({trace: this.appConfig.trace}, null, 2))
    }

    /**
     * A trace toggle stored by setTrace wins over `trace` in app.config.json. A state file that cannot be read keeps the
     * value from app.config.json
     */
    __applyStoredTrace() {
        if (!fs.existsSync(statePath))
            return
        try {
            const {trace} = JSON.parse(fs.readFileSync(statePath).toString().trim())
            if (typeof trace === 'boolean')
                this.appConfig.trace = trace
        } catch (err) {
            logger.warn({msg: 'The stored trace state cannot be read; the trace setting in app.config.json applies', err: err.message})
        }
    }

    /**
     * Adopts the scheduled update once it has landed. The floors are stored before the pending file is removed, in the
     * order the boot recovery path uses: a stop at any point leaves either the floors stored or a pending file equal to
     * the current config, which the next boot turns into the same floors
     *
     * The cluster runner passes the envelope and the base config the landed transaction was built from, because a CONFIG
     * message can clear or replace the pending config while the round is in flight - an update the orchestrator rejected
     * at its expiration date or its initiator withdrew, or the echo of the applied config arriving before the submit
     * returns. Then: when the landed config is already the current one (adopted from the echo), nothing is
     * adopted again; when the base config is unchanged, the landed envelope is adopted, as a majority of the current set
     * verified it when it was scheduled and a majority of node signatures put it on-chain, so this node's signer set
     * stays the chain's; when the base config changed meanwhile, nothing is adopted. The pending config is cleared only
     * when it is the one that landed. Nothing here reads a cleared pending config
     * @param {number} nonce - this node's own vote on the update, stored as its CONFIG nonce
     * @param {ConfigEnvelope} [landed] - the envelope the landed transaction was built from; the pending config if omitted
     * @param {Config} [base] - the current config the transaction was built against; the current config if omitted
     */
    async applyPendingUpdate(nonce, landed = this.pendingConfig, base = this.config) {
        if (!landed || !this.config || !base) {
            logger.error({msg: 'A cluster update landed, but there is no update to apply or no config it was built against'})
            return
        }
        const landedHash = landed.config.getHash()
        const isPendingLanded = this.pendingConfig?.config.getHash() === landedHash
        if (this.config.getHash() === landedHash) {
            //the orchestrator's echo of the applied config arrived while the round was in flight and was adopted, floors
            //included, by the config handler
            if (isPendingLanded)
                this.clearPendingConfig()
            return
        }
        const baseHash = base.getHash()
        if (this.config.getHash() !== baseHash) {
            logger.error({
                msg: 'A cluster update landed, but the config it was built against was replaced while it was in flight; adopting nothing. The chain and this node disagree until an operator reconciles them',
                hash: landedHash,
                baseHash,
                currentHash: this.config.getHash()
            })
            return
        }
        //counted against the node set that voted on it, which is the one about to be replaced
        const nodes = [...this.config.nodes.keys()]
        const lowestNonce = getLowestCountedNonce(landed, nodes)
        if (isPendingLanded) {
            await this.setConfig(landed.config, nonce)
            this.raisePendingConfigFloor(lowestNonce)
            this.raiseConfigFloor(lowestNonce)
            this.clearPendingConfig()
            return
        }
        logger.error({
            msg: 'A cluster update landed after the orchestrator cleared or replaced it: the chain moved without the orchestrator. Adopting the landed config; the orchestrator record needs an operator',
            hash: landedHash,
            pendingHash: this.pendingConfig?.config.getHash() || null
        })
        //no pending file holds the landed update, so nothing on disk would raise the floors again after a stop: they are
        //stored before the config is written, as the config handler does
        this.raisePendingConfigFloor(lowestNonce)
        this.raiseConfigFloor(lowestNonce)
        await this.setConfig(landed.config, nonce)
    }

    /**
     * Raises the PENDING_CONFIG floor to the lowest counted nonce of a config this node has just adopted. A floor that
     * moved only with this node's own votes would let a node that did not vote on the latest change accept a
     * replayed proposal signed before it. Signature nonces are the signers' signing times and a later proposal is signed
     * after the config it follows was applied, so an honest one clears the raised floor. The lowest counted nonce,
     * not the highest: a top-up of the adopted config can be signed after the next proposal was, and must not lift the
     * floor past it, while a replay signed before the adopted config's earliest counted signature is still below it.
     *
     * Nonces come from each operator's own browser clock, so the floor compares one operator's clock with another's.
     * It is therefore capped at this node's clock at the moment of adoption: a signer whose clock runs hours ahead cannot
     * lift the floor past real time and refuse the next honest proposal on every node, while a replay signed before the
     * adopted config is still below it. The floor is per-node state and never reaches a payload, so reading the clock
     * here does not touch consensus. Remaining risk: a signer whose clock lags the adopted config's earliest counted
     * signer by more than the time between the two signatures signs below the CONFIG floor, which is raised with this
     * one. A next proposal is refused while every counted signature is below this floor, and, since verifyConfig counts
     * fresh signatures against the CONFIG floor, while fewer than a majority of the current set are at or above that
     * one: one such signer is enough on a bare majority. It ends when enough operators with
     * correct clocks have signed.
     * @param {number} nonce - lowest counted nonce of the adopted config
     */
    //eslint-disable-next-line class-methods-use-this
    raisePendingConfigFloor(nonce) {
        const {PENDING_CONFIG} = nonceManager.nonceTypes
        if (!Number.isSafeInteger(nonce))
            return
        const floor = Math.min(nonce, Date.now())
        if (floor > nonceManager.getNonce(PENDING_CONFIG))
            nonceManager.setNonce(PENDING_CONFIG, floor)
    }

    /**
     * Raises the CONFIG floor to the lowest counted nonce of a config this node has just adopted, so a config signed
     * before it is refused although this node voted on neither. verifyConfig also requires a majority
     * of the current node set to have signed a pending or current envelope at or after it, so the config this one
     * replaced does not come back on the top-ups of operators who had not signed it, unless a later config removed
     * its other signers. Capped at this node's clock like the pending floor; per-node
     * state that never reaches a payload
     * @param {number} nonce - lowest counted nonce of the adopted config
     */
    //eslint-disable-next-line class-methods-use-this
    raiseConfigFloor(nonce) {
        const {CONFIG_FLOOR} = nonceManager.nonceTypes
        if (!Number.isSafeInteger(nonce) || nonce <= 0)
            return
        const floor = Math.min(nonce, Date.now())
        if (floor > nonceManager.getNonce(CONFIG_FLOOR))
            nonceManager.setNonce(CONFIG_FLOOR, floor)
    }

    clearPendingConfig() {
        this.pendingConfig = null
        this.pendingExpirationDate = null
        //remove pending config
        if (fs.existsSync(clusterPendingConfigPath))
            fs.unlinkSync(clusterPendingConfigPath)
    }

    /**
     * @param {AppConfig} config - config
     */
    async setAppConfig(config) {
        this.appConfig = config
        logger.init(this.appConfig.trace)
        await dataSourceManager.setDataSources([...config.dataSources.values()], container.homeDir)
    }

    /**
     * @param {Config} config - config
     * @param {number} nonce - nonce for the config
     * @param {boolean} [save] - save config to file
     */
    async setConfig(config, nonce, save = true) {
        //setPendingConfig reaches the same check through buildUpdates, but a current config adopted directly - the
        //normal path for a node that was offline across an update - gets the same continuity check
        if (this.config && !isAllowedValidatorsUpdate([...this.config.nodes.keys()], [...config.nodes.keys()]))
            throw new Error('Validators update is not allowed: a majority of the current node set must remain')
        this.config = config
        if (!config.clusterSecret)
            logger.warn('RSA key is not defined')
        this.clusterSecretObject = config.clusterSecret ? await importRSAKey(Buffer.from(config.clusterSecret, 'base64')) : null
        const contracts = new Map([...config.contracts.values()].map(c => ([c.contractId, c.type])))
        runnerManager.setContracts(contracts)
        nodesManager.setNodes(config.nodes)
        statisticsManager.setContractIds([...config.contracts.keys()])
        container.tradesManager.setNodes([...config.nodes.keys()])
        runnerManager.start()
        if (nonce) //set nonce on config update
            nonceManager.setNonce(nonceManager.nonceTypes.CONFIG, nonce)
        if (save)
            writeFileAtomic(clusterConfigPath, JSON.stringify(config.toPlainObject(), null, 2))
    }

    /**
     * @param {ConfigEnvelope} envelope - config
     * @param {number} nonce - nonce for the pending config
     * @param {boolean} [save] - save config to file
     * @param {any} [expirationDate] - the expiration date node-orchestrator sent beside the envelope, milliseconds. It is
     * kept only when it is a positive safe integer; anything else, or none, leaves the node building every due round as
     * before. Every CONFIG for the held update replaces it
     */
    setPendingConfig(envelope, nonce, save = true, expirationDate = null) {
        if (this.pendingConfig && this.pendingConfig.config.getHash() !== envelope.config.getHash())//allow update current config
            throw new Error('Pending config already exists')
        const updates = buildUpdates(envelope.timestamp, this.config, envelope.config)
        if (updates.size === 0)
            throw new Error('No updates found in pending config')
        this.pendingConfig = envelope
        this.pendingExpirationDate = Number.isSafeInteger(expirationDate) && expirationDate > 0 ? expirationDate : null
        if (nonce)
            nonceManager.setNonce(nonceManager.nonceTypes.PENDING_CONFIG, nonce)
        if (save) {
            //stored beside the envelope, whose own plain object - what the node verifies and signs against - is unchanged
            const stored = this.pendingExpirationDate
                ? {...envelope.toPlainObject(), expirationDate: this.pendingExpirationDate}
                : envelope.toPlainObject()
            writeFileAtomic(clusterPendingConfigPath, JSON.stringify(stored, null, 2))
        }
    }

    /**
     * Applies the gateway list. The consumer must always find an object here: an undefined `gateways` would throw
     * inside the trigger handler and silently disable every webhook.
     * `urls` carries three states and the empty one is NOT "no gateways":
     * `null` - none configured, so a direct request is the only route there is;
     * a non-empty array - the usable gateways, and every request goes through them;
     * `[]` - gateways are configured and none is usable, so there is no route and nothing is sent.
     * @param {{urls: string[], challenge: string}} gatewaysData - gateway data from disk or from the orchestrator
     * @param {boolean} [save] - persist the configured list to gateways.json
     */
    setGateways(gatewaysData, save = true) {
        const {urls, challenge} = gatewaysData || {}
        if (!challenge || typeof challenge !== 'string')
            throw new Error('Gateway challenge is required')
        if (urls !== undefined && urls !== null && !Array.isArray(urls))
            throw new Error('Gateways must be an array')
        const configuredUrls = Array.isArray(urls) ? [...urls] : []
        if (configuredUrls.length > maxGatewayUrls)
            throw new Error(`Too many gateway urls: ${configuredUrls.length}`)
        const validUrls = []
        const rejected = []
        for (const url of configuredUrls) {
            try {
                validUrls.push(validateGatewayUrl(url))
            } catch (err) {
                rejected.push(err.message)
            }
        }
        let routableUrls
        if (configuredUrls.length === 0) {
            routableUrls = null //nothing configured: a direct webhook post is the only route there is
        } else if (validUrls.length === 0) {
            //fail closed. Going direct would reveal the node address, which is the one thing gateways exist to
            //prevent, so an empty array here means "no route" and the webhook is simply not sent
            logger.error({msg: 'Every configured gateway url was rejected; webhook notifications will not be sent rather than go direct', configured: configuredUrls.length, rejected})
            routableUrls = []
        } else {
            if (rejected.length > 0) //the orchestrator pushed a signed list; say plainly that part of it is unused
                logger.error({msg: 'Gateway list partially rejected; the routing set is smaller than the list pushed', configured: configuredUrls.length, accepted: validUrls.length, rejected})
            routableUrls = validUrls
        }
        this.__applyGateways(routableUrls, configuredUrls, challenge, save)
    }

    /**
     * Installs one gateway state. The configured list is written first, so a list that could not be persisted never
     * routes in memory while the file on disk still reads back as a different state on the next boot.
     * @param {string[]|null} urls - routing set: null none configured, [] none usable, otherwise the usable gateways
     * @param {string[]} configuredUrls - the list as pushed or read from disk
     * @param {string} challenge - gateway challenge
     * @param {boolean} save - persist the configured list to gateways.json
     * @private
     */
    __applyGateways(urls, configuredUrls, challenge, save) {
        const gatewayValidationKey = Buffer.from(this.appConfig.keypair.sign(
            Buffer.from(getDataHash(challenge, this.appConfig.publicKey), 'hex')
        )).toString('base64')
        if (save)
            //persist what was configured, not the subset that validated: a truncated file would read back on the next
            //boot as "no gateways configured", which is the state that posts directly
            writeFileAtomic(gatewaysPath, JSON.stringify({urls: configuredUrls, challenge}, null, 2))
        this.gateways = {urls, configuredUrls, challenge, gatewayValidationKey}
        dataSourceManager.setGateways(this.gateways)
        if (isDebugging()) //the key itself is the token gateways accept, so only a fingerprint of it is logged
            logger.info({msg: 'Gateway validation key applied', fingerprint: getKeyFingerprint(gatewayValidationKey)})
    }

    /**
     * @type {Map<string, Node>}
     */
    get nodes() {
        return this.config.nodes
    }

    get network() {
        return this.config.network
    }

    /**
     * @param {string} contractId - contract id
     * @returns {OracleConfig|SubscriptionsConfig|DAOConfig}
     */
    getContractConfig(contractId) {
        return __getContractConfig(this.config, contractId)
    }

    getDecimals(contractId) {
        if (!contractId)
            return this.config.decimals || defaultDecimals
        const contractConfig = __getContractConfig(this.config, contractId)
        return contractConfig.decimals || this.config.decimals || defaultDecimals
    }

    getOperators() {
        return [...this.config.nodes.keys()]
    }

    getBaseAsset(source) {
        if (!source)
            throw new Error('Source is required')
        if (this.config.baseAssets?.has(source))
            return this.config.baseAssets.get(source)
        if (!defaultBaseAssets.has(source))
            throw new Error(`Base asset not found for source: ${source}`)
        return defaultBaseAssets.get(source)
    }

    /**
     * @param {string} contractId - contract id
     * @param {string} [type] - contract type
     * @returns {OracleConfig|SubscriptionsConfig}
     */
    hasContractConfig(contractId, type = null) {
        return __hasContractConfig(this.config, contractId, type)
    }

    /**
     * Returns the contract assets, with every asset that has expired at the tick timestamp replaced by null.
     * Expiry is a consensus input, so it is evaluated at the agreed tick timestamp and never at the local clock.
     * @param {string} contractId - contract id
     * @param {number} timestamp - tick timestamp in milliseconds
     * @returns {Array<Asset|null>}
     */
    getAssets(contractId, timestamp) {
        //isInteger, not isFinite: Number.isFinite(1.5) is true and BigInt(1.5) throws a RangeError four lines down,
        //and this guard exists precisely to catch a caller that got the timestamp wrong
        if (!Number.isInteger(timestamp))
            throw new Error('Timestamp is required to evaluate asset expiration')
        const assets = [...__getContractConfig(this.config, contractId).assets]
        const assetExpiration = this.__assetExpiration.get(contractId)
        if (!assetExpiration) //no expiration information for this contract yet - nothing is expired
            return assets
        const tick = BigInt(timestamp)
        const count = Math.min(assetExpiration.length, assets.length)
        for (let i = 0; i < count; i++) {
            const expiration = assetExpiration[i]
            //Only a missing index is unknown, and unknown is active. An explicit 0 is NOT "never expires": the contract
            //writes 0 for a feed nobody has paid for (beam starts every feed at 0 until track() raises it), extend_ttl
            //treats 0 exactly like a lapsed value, and the contract's own never-expires marker is DISTANT_FUTURE. So 0
            //goes through the comparison below and is expired at any positive tick
            if (expiration === undefined)
                continue
            if (tick > expiration)
                assets[i] = null
        }
        return assets
    }

    /**
     * @param {string} contractId - contract id
     * @param {BigInt[]} expiration - asset expirations read from the contract instance
     */
    setAssetExpiration(contractId, expiration) {
        if (!contractId)
            throw new Error('Contract id is required')
        if (expiration === undefined || expiration === null)
            return
        if (!Array.isArray(expiration)) {
            logger.warn({msg: 'Contract asset expiration is not an array; assets stay active', contract: contractId, expirationType: typeof expiration})
            return
        }
        this.__assetExpiration.set(contractId, expiration)
    }

    /**
     * Returns blockchain connector settings for current network
     * @returns {{networkPassphrase: string, sorobanRpc: string[], blockchainConnector: string}}
     */
    getBlockchainConnectorSettings() {
        const {networkPassphrase, sorobanRpc, dbConnector} = dataSourceManager.get(this.config.network) || {}
        if (!networkPassphrase)
            throw new Error(`Network passphrase not found: ${this.config.network}`)
        if (!sorobanRpc)
            throw new Error(`Soroban rpc urls not found: ${this.config.network}`)
        return {networkPassphrase, sorobanRpc, blockchainConnector: dbConnector}
    }

    /**
     * Returns set price heartbeat or 2 hours as default
     * @returns {Number}
     */
    getPriceHeartbeat() {
        return this.config.priceHeartbeat || 2 * 60 * 60 * 1000 //default is 2 hours
    }

    /**
     * Returns the simulation source for the pubnet, or undefined
     * @returns {string|null}
     */
    getSimSource() {
        if (this.config.network === 'pubnet') {
            return this.config.systemAccount
        }
    }

    /**
     * Returns node settings statistics
     */
    get statistics() {
        //a copy: the data source manager's own list must not grow by one entry per statistics request
        const connectionIssues = [...(dataSourceManager.issues || [])]
        //configured but none usable stops webhooks and exchanges fetches on this node; the orchestrator alerts the
        //operator on connection issues, so the state is reported there rather than only in the log
        if (Array.isArray(this.gateways?.urls) && this.gateways.urls.length === 0)
            connectionIssues.push('Gateways are configured but none is usable: webhooks are not sent and exchanges prices are not fetched until the gateway list is fixed')
        if (this.config && this.config.isValid) {
            const dataSources = [...this.config.contracts.values()]
                .filter(c => c.type === ContractTypes.ORACLE || c.type === ContractTypes.ORACLE_BEAM)
                .map(c => c.dataSource)
            for (const dataSource of dataSources) {
                if (!dataSourceManager.has(dataSource))
                    connectionIssues.push(`Connection data for data source ${dataSource} not found`)
            }
            if (!dataSourceManager.has(this.config.network))
                connectionIssues.push(`Connection data for network ${this.config.network} not found`)
        }
        return {
            currentConfigHash: this.config ? this.config.getHash() : null,
            pendingConfigHash: this.pendingConfig ? this.pendingConfig.config.getHash() : null,
            connectionIssues,
            version: container.version,
            isTraceEnabled: this.appConfig.trace
        }
    }

    __assetExpiration = new Map()

    dispose() {
        dataSourceManager.dispose()
    }

}

module.exports = SettingsManager