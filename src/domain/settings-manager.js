const fs = require('fs')
const {createHash} = require('crypto')
const {ValidationError, ConfigEnvelope, buildUpdates, Config, ContractTypes, getDataHash} = require('@reflector/reflector-shared')
const AppConfig = require('../models/app-config')
const logger = require('../logger')
const {importRSAKey, randomUUID} = require('../utils/crypto-helper')
const nonceManager = require('../ws-server/nonce-manager')
const {isDebugging} = require('../utils')
const {validateGatewayUrl, maxGatewayUrls} = require('../utils/ssrf-validator')
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
        //set app config
        if (!fs.existsSync(appConfigPath))
            throw new Error('Config file not found')
        const rawAppConfig = JSON.parse(fs.readFileSync(appConfigPath).toString().trim())
        this.appConfig = new AppConfig(rawAppConfig)
        if (!this.appConfig.isValid) {
            //shutdown the app if app config is invalid
            throw new Error(`Invalid app config. Issues: ${this.appConfig.issuesString}`)
        }
        await this.setAppConfig(this.appConfig)

        //set gateways. Only a missing file means "no gateways configured": a gateways.json that exists belongs to a
        //node that configured gateways, so a file this node cannot use fails closed instead of going direct
        const gatewaysExist = fs.existsSync(gatewaysPath)
        if (!gatewaysExist) {
            //first boot: nothing is configured, so the direct route is the only one there is
            this.setGateways({urls: [], challenge: randomUUID(32)}, true)
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
            if (!clusterConfig.isValid) {
                logger.error({msg: 'Invalid config. Config will not be assigned. Issues:', issues: clusterConfig.issuesString})
            } else
                await this.setConfig(clusterConfig, null, false)
        }
        //set pending updates
        const rawPendingConfig = fs.existsSync(clusterPendingConfigPath)
            ? JSON.parse(fs.readFileSync(clusterPendingConfigPath).toString().trim())
            : null
        if (rawPendingConfig) {
            const clusterPendingConfig = new ConfigEnvelope(rawPendingConfig)
            if (!clusterPendingConfig.config.isValid) {
                logger.error({msg: 'Invalid pending config. Config will not be assigned. Issues:', issues: clusterPendingConfig.issuesString})
            } else
                this.setPendingConfig(clusterPendingConfig, null, false)
        }
    }

    setTrace(trace) {
        this.appConfig.trace = !!trace
        logger.setTrace(this.appConfig.trace)
        fs.writeFileSync(appConfigPath, JSON.stringify(this.appConfig.toPlainObject(), null, 2))
    }

    async applyPendingUpdate(nonce) {
        await this.setConfig(this.pendingConfig.config, nonce)
        this.clearPendingConfig()
    }

    clearPendingConfig() {
        this.pendingConfig = null
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
            fs.writeFileSync(clusterConfigPath, JSON.stringify(config.toPlainObject(), null, 2))
    }

    /**
     * @param {ConfigEnvelope} envelope - config
     * @param {number} nonce - nonce for the pending config
     * @param {boolean} [save] - save config to file
     */
    setPendingConfig(envelope, nonce, save = true) {
        if (this.pendingConfig && this.pendingConfig.config.getHash() !== envelope.config.getHash())//allow update current config
            throw new Error('Pending config already exists')
        const updates = buildUpdates(envelope.timestamp, this.config, envelope.config)
        if (updates.size === 0)
            throw new Error('No updates found in pending config')
        this.pendingConfig = envelope
        if (nonce)
            nonceManager.setNonce(nonceManager.nonceTypes.PENDING_CONFIG, nonce)
        if (save)
            fs.writeFileSync(clusterPendingConfigPath, JSON.stringify(envelope.toPlainObject(), null, 2))
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
            fs.writeFileSync(gatewaysPath, JSON.stringify({urls: configuredUrls, challenge}, null, 2))
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