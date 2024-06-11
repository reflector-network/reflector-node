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

    toPlainObject() {
        return {
            dataSources: mapToPlainObject(this.dataSources),
            dbSyncDelay: this.dbSyncDelay,
            handshakeTimeout: this.handshakeTimeout,
            secret: this.secret,
            orchestratorUrl: this.orchestratorUrl,
            trace: this.trace,
            port: this.port
        }
    }
}

module.exports = AppConfig