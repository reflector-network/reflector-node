const {Keypair, StrKey} = require('@stellar/stellar-sdk')
const {IssuesContainer, mapToPlainObject} = require('@reflector/reflector-shared')
const logger = require('../logger')
const DataSource = require('./data-source')
const configHashPattern = /^[0-9a-fA-F]{64}$/
//STATISTICS_REQUEST is unsigned and a node trusts whatever answers on this url, so TLS is what authenticates the
//orchestrator. Plain http and ws are accepted too, for a local or staging cluster without a certificate, with a warning
//when the host is not this machine: the orchestrator then reaches the node, cluster secret included, unencrypted
const encryptedOrchestratorProtocols = ['wss:', 'https:']
const plainOrchestratorProtocols = ['ws:', 'http:']

function isLoopbackHost(hostname) {
    return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname)
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
        //the sync delays are fixed for every node (src/domain/sync-delays.js): a node with its own would sign transactions
        //its peers do not, so an old setting is ignored
        if (config.dbSyncDelay !== undefined)
            logger.warn({msg: 'dbSyncDelay is no longer read; the sync delays are fixed for every node'})
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
            const {protocol, hostname} = parsed
            if (!encryptedOrchestratorProtocols.includes(protocol) && !plainOrchestratorProtocols.includes(protocol))
                throw new Error(`must use wss://, https://, ws:// or http://, got ${protocol}//${hostname}`)
            if (plainOrchestratorProtocols.includes(protocol) && !isLoopbackHost(hostname))
                logger.warn({msg: 'orchestratorUrl uses plain http or ws to another host: the orchestrator is not authenticated and the cluster secret travels unencrypted', host: hostname})
            this.orchestratorUrl = orchestratorUrl
        } catch (e) {
            this.__addIssue(`orchestratorUrl: ${e.message}`)
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