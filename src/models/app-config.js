const {Keypair, StrKey} = require('@stellar/stellar-sdk')
const {IssuesContainer, mapToPlainObject} = require('@reflector/reflector-shared')
const DataSource = require('./data-source')
const defaultDbSyncDelay = 15_000
const configHashPattern = /^[0-9a-fA-F]{64}$/
//STATISTICS_REQUEST is unsigned and a node trusts whatever answers on this url, so TLS is what authenticates the
//orchestrator
const orchestratorProtocols = ['wss:', 'https:']

function getNormalizedDbSyncDelay(dbSyncDelay) {
    if (dbSyncDelay === defaultDbSyncDelay)
        return undefined
    return dbSyncDelay / 1000
}

class AppConfig extends IssuesContainer {
    /**
     * @param {any} config - raw config object
     */
    constructor(config) {
        super()
        if (!config) {
            this.__addConfigIssue(`config: ${IssuesContainer.notDefined}`)
            return
        }
        this.handshakeTimeout = config.handshakeTimeout || 5000
        this.__assignKeypair(config.secret)
        this.__assignDataSources(config.dataSources)
        this.__assignOrchestratorUrl(config.orchestratorUrl)
        this.__assignDbSyncDelay(config.dbSyncDelay)
        this.__assignPort(config.port)
        this.__assignTrace(config.trace)
        this.__assignClusterConfigHash(config.clusterConfigHash)
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
     * @type {Map<string, DataSource>}
     */
    dataSources = new Map()

    /**
     * @type {number}
     */
    dbSyncDelay

    /**
     * @type {number}
     */
    port

    /**
     * @type {boolean}
     */
    trace = false

    /**
     * @type {string}
     */
    orchestratorUrl

    /**
     * Hash of the cluster config this node is allowed to adopt when it holds none yet. Optional: absent means no
     * anchor, which only matters at bootstrap, where the node then needs its own accepting signature instead
     * @type {string}
     */
    clusterConfigHash

    __assignKeypair(secret) {
        try {
            if (!(secret && StrKey.isValidEd25519SecretSeed(secret)))
                throw new Error(IssuesContainer.invalidOrNotDefined)
            this.keypair = Keypair.fromSecret(secret)
            this.publicKey = this.keypair.publicKey()
            this.secret = secret
        } catch (e) {
            this.__addIssue(`secret: ${e.message}`)
        }
    }

    __assignDataSources(dataSources) {
        try {
            if (!dataSources)
                throw new Error(IssuesContainer.notDefined)
            const sourceKeys = Object.keys(dataSources)

            if (!sourceKeys.length)
                throw new Error(IssuesContainer.notDefined)
            if (sourceKeys.length !== new Set(sourceKeys).size)
                throw new Error('Duplicate data source name found in dataSources')

            for (const sourceKey of sourceKeys) {
                try {
                    const rawSource = dataSources[sourceKey]
                    this.dataSources.set(sourceKey, new DataSource(rawSource))
                } catch (e) {
                    this.__addIssue(`dataSources.${sourceKey}: ${e.message}`)
                }
            }
        } catch (e) {
            this.__addIssue(`dataSources: ${e.message}`)
        }
    }

    __assignOrchestratorUrl(orchestratorUrl) {
        try {
            if (!orchestratorUrl)
                return
            let parsed = null
            try {
                parsed = new URL(orchestratorUrl)
            } catch (e) {
                throw new Error('must be a valid url')
            }
            if (!orchestratorProtocols.includes(parsed.protocol))
                throw new Error(`must use wss:// or https://, got ${parsed.protocol}`)
            this.orchestratorUrl = orchestratorUrl
        } catch (e) {
            this.__addIssue(`orchestratorUrl: ${e.message}`)
        }
    }

    __assignDbSyncDelay(dbSyncDelay) {
        try {
            this.dbSyncDelay = !dbSyncDelay || isNaN(dbSyncDelay) ? defaultDbSyncDelay : dbSyncDelay * 1000
        } catch (e) {
            this.__addIssue(`dbSyncDelay: ${e.message}`)
        }
    }

    __assignPort(port) {
        try {
            if (!port || isNaN(port))
                return
            this.port = port
        } catch (e) {
            this.__addIssue(`port: ${e.message}`)
        }
    }

    __assignTrace(trace) {
        this.trace = !!trace
    }

    __assignClusterConfigHash(clusterConfigHash) {
        try {
            if (!clusterConfigHash)
                return
            if (typeof clusterConfigHash !== 'string' || !configHashPattern.test(clusterConfigHash))
                throw new Error('Cluster config hash must be 64 hex characters')
            this.clusterConfigHash = clusterConfigHash.toLowerCase()
        } catch (e) {
            this.__addIssue(`clusterConfigHash: ${e.message}`)
        }
    }

    toPlainObject() {
        return {
            dataSources: mapToPlainObject(this.dataSources),
            dbSyncDelay: getNormalizedDbSyncDelay(this.dbSyncDelay),
            handshakeTimeout: this.handshakeTimeout,
            secret: this.secret,
            orchestratorUrl: this.orchestratorUrl,
            clusterConfigHash: this.clusterConfigHash,
            trace: this.trace,
            port: this.port
        }
    }
}

module.exports = AppConfig