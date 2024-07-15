const {Keypair, StrKey} = require('@stellar/stellar-sdk')
const {IssuesContainer} = require('@reflector/reflector-shared')
const {mapToPlainObject} = require('@reflector/reflector-shared/utils/map-helper')
const DataSource = require('./data-source')

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
        this.__assignRSAKey(config.rsaKey, config.rsaKeyObject)
        this.__assignProxy(config.proxy, config.dataSources)
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
     * @type {string} - base64 encoded RSA private key
     */
    rsaKey

    /**
     * @type {KeyObject} - RSA private key object
     */
    rsaKeyObject

    /**
     * @type {{connectionString: string, useCurrent: boolean}}
     */
    proxy = null

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
            this.orchestratorUrl = orchestratorUrl
        } catch (e) {
            this.__addIssue(`orchestratorUrl: ${e.message}`)
        }
    }

    __assignDbSyncDelay(dbSyncDelay) {
        try {
            if (!dbSyncDelay || isNaN(dbSyncDelay))
                return
            this.dbSyncDelay = dbSyncDelay
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

    __assignRSAKey(rsaKey, rsaKeyObject) {
        try {
            if (!rsaKey)
                throw new Error(IssuesContainer.notDefined)
            this.rsaKey = rsaKey
            this.rsaKeyObject = rsaKeyObject
        } catch (e) {
            this.__addIssue(`cryptoPrivateKey: ${e.message}`)
        }
    }

    __assignProxy(proxy, rawDataSources) {
        try {
            if (proxy && proxy.connectionString) {
                this.proxy = proxy
                return
            }
            //legacy support
            const proxySource = Object.values(rawDataSources).find(ds => ds.proxy)
            if (!proxySource)
                return
            this.proxy = proxySource.proxy
        } catch (e) {
            this.__addIssue(`proxy: ${e.message}`)
        }
    }

    toPlainObject() {
        return {
            dataSources: mapToPlainObject(this.dataSources),
            dbSyncDelay: this.dbSyncDelay,
            handshakeTimeout: this.handshakeTimeout,
            secret: this.secret,
            orchestratorUrl: this.orchestratorUrl,
            trace: this.trace,
            port: this.port,
            rsaKey: this.rsaKey,
            proxy: this.proxy
        }
    }
}

module.exports = AppConfig