const {Keypair, StrKey} = require('soroban-client')
const ContractConfig = require('./contract/reflector-config')
const ConfigBase = require('./config-base')

class NodeAddress {

    constructor(pubkey, url) {
        if (!pubkey)
            throw new Error('pubkey is required')
        if (!StrKey.isValidEd25519PublicKey(pubkey))
            throw new Error('pubkey is invalid')
        this.pubkey = pubkey
        this.url = url
    }

    /**
     * @type {string}
     */
    pubkey

    /**
     * @type {string}
     */
    url
}

class Config extends ConfigBase {
    /**
     * @param {any} config - raw config object
     * @param {string} secret - node secret
     * @param {string} dockerDbPassword - password for docker db
     */
    constructor(config, secret, dockerDbPassword) {
        super()
        if (!config) {
            this.__addConfigIssue(`config: ${ConfigBase.notDefined}`)
            return
        }
        this.handshakeTimeout = config.handshakeTimeout || 5000
        this.dbSyncDelay = (config.dbSyncDelay && !isNaN(config.dbSyncDelay)) ? config.dbSyncDelay : 15
        this.__assignKeypair(secret)
        this.__assignDbConnectionSettings(config, dockerDbPassword)
        this.__assignContractSettings(config)
        this.__assignNodeAddresses(config)
    }

    /**
     * @type {Keypair}
     */
    keypair

    /**
     * @type {string}
     */
    publicKey

    /**
     * @type {string}
     */
    secret

    /**
     * @type {ContractConfig}
     */
    contractSettings

    /**
     * @type {NodeAddress[]}
     */
    nodes = []

    /**
     * @type {string}
     */
    dbConnectionString

    /**
     * @type {string}
     */
    dockerDbPassword

    /**
     * @type {number}
     */
    dbSyncDelay

    __assignKeypair(secret) {
        try {
            if (!(secret && StrKey.isValidEd25519SecretSeed(secret)))
                throw new Error(ConfigBase.invalidOrNotDefined)
            this.keypair = Keypair.fromSecret(secret)
            this.publicKey = this.keypair.publicKey()
            this.secret = secret
        } catch (e) {
            this.__addConfigIssue(`secret: ${e.message}`)
        }
    }

    __assignContractSettings(config) {
        this.contractSettings = new ContractConfig(config.contractSettings)
        if (this.publicKey
            && this.contractSettings.nodes
            && !this.contractSettings.nodes.find(n => n === this.publicKey))
            throw new Error('Current node is not in the list of reflector nodes')
        for (const issue of (this.contractSettings?.issues || []))
            this.__addConfigIssue(`contractSettings.${issue}`)
    }

    __assignNodeAddresses(config) {
        try {
            if (!(config.nodes && Array.isArray(config.nodes) && config.nodes.length > 0))
                throw new Error(ConfigBase.invalidOrNotDefined)
            const uniquePubkeys = new Set(config.nodes.map(n => n.pubkey))
            if (uniquePubkeys.size !== config.nodes.length)
                throw new Error('Contains duplicates')
            this.nodes = config.nodes.map(n => new NodeAddress(n.pubkey, n.url))
        } catch (e) {
            this.__addConfigIssue(`nodes: ${e.message}`)
        }
    }

    __assignDbConnectionSettings(config, dockerDbPassword) {
        try {
            this.dockerDbPassword = config.dockerDbPassword
            this.dbConnectionString = config.dbConnectionString
            this.dockerDbPassword = dockerDbPassword
            if (!this.dbConnectionString && !this.dockerDbPassword)
                throw new Error(ConfigBase.invalidOrNotDefined)
            this.dbSyncDelay = config.dbSyncDelay
        } catch (e) {
            this.__addConfigIssue(`dbConnectionString: ${e.message}`)
        }
    }

    toPlainObject() {
        return {
            contractSettings: this.contractSettings.toPlainObject(),
            nodes: this.nodes,
            dbConnectionString: this.dbConnectionString,
            dbSyncDelay: this.dbSyncDelay,
            handshakeTimeout: this.handshakeTimeout
        }
    }
}

module.exports = Config