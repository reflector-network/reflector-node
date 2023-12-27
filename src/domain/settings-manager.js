
const fs = require('fs')
const {ValidationError, ConfigEnvelope, buildUpdates, Config} = require('@reflector/reflector-shared')
const AppConfig = require('../models/app-config')
const logger = require('../logger')
const nodesManager = require('./nodes/nodes-manager')
const container = require('./container')
const connectionManager = require('./data-sources-manager')

const appConfigPath = `${container.homeDir}/app.config.json`
const oracleConfigPath = `${container.homeDir}/.config.json`
const oraclePendingConfigPath = `${container.homeDir}/.pending.config.json`
const dockerDbPasswordPath = `${container.homeDir}/.dockerDbPassword`

/**
 * @typedef {import('@reflector/reflector-shared').Node} Node
 */

/**
 * @param {Config} config - config
 * @param {string} oracleId - oracle id
 * @returns {ContractConfig}
 */
function __getContractConfig(config, oracleId) {
    const contractConfig = config.contracts.get(oracleId)
    if (!contractConfig)
        throw new ValidationError('Contract not found')
    return contractConfig
}

function __getDockerDbPassword() {
    if (!fs.existsSync(dockerDbPasswordPath)) {
        return null
    }
    return fs.readFileSync(dockerDbPasswordPath).toString().trim()
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

    init() {
        //set app config
        if (!fs.existsSync(appConfigPath))
            throw new Error('Config file not found')
        const rawAppConfig = JSON.parse(fs.readFileSync(appConfigPath).toString().trim())
        rawAppConfig.dockerDbPassword = __getDockerDbPassword()
        this.appConfig = new AppConfig(rawAppConfig)
        if (!this.appConfig.isValid) {
            //shutdown the app if app config is invalid
            throw new Error(`Invalid app config. Issues: ${this.appConfig.issuesString}`)
        }
        this.setAppConfig(this.appConfig)

        //set current config
        const rawConfig = fs.existsSync(oracleConfigPath)
            ? JSON.parse(fs.readFileSync(oracleConfigPath).toString().trim())
            : null
        if (rawConfig) {
            const oraclesConfig = new Config(rawConfig)
            if (!oraclesConfig.isValid) {
                logger.error(`Invalid config. Config will not be assigned. Issues: ${oraclesConfig.issuesString}`)
            } else
                this.setConfig(oraclesConfig, false)
        }
        //set pending updates
        const rawPendingConfig = fs.existsSync(oraclePendingConfigPath)
            ? JSON.parse(fs.readFileSync(oraclePendingConfigPath).toString().trim())
            : null
        if (rawPendingConfig) {
            const oraclesPendingConfig = new ConfigEnvelope(rawPendingConfig)
            if (!oraclesPendingConfig.config.isValid) {
                logger.error(`Invalid pending config. Config will not by assigned. Issues: ${oraclesPendingConfig.issuesString}`)
            } else
                this.setPendingConfig(oraclesPendingConfig, false)
        }
    }

    applyPendingUpdate() {
        this.setConfig(this.pendingConfig.config)
        this.pendingConfig = null
        //remove pending config
        fs.unlinkSync(oraclePendingConfigPath)
    }

    /**
     * @param {AppConfig} config - config
     */
    setAppConfig(config) {
        this.appConfig = config
        connectionManager.setDataSources([...config.dataSources.values()])
    }

    /**
     * @param {Config} config - config
     * @param {boolean} [save] - save config to file
     */
    setConfig(config, save = true) {
        this.config = config
        if (!this.config.isValid)
            return
        container.oracleRunnerManager.setOracleIds([...config.contracts.keys()])
        nodesManager.setNodes(config.nodes)
        if (save)
            fs.writeFileSync(oracleConfigPath, JSON.stringify(config.toPlainObject(), null, 2))
    }

    /**
     * @param {ConfigEnvelope} envelope - config
     * @param {boolean} [save] - save config to file
     */
    setPendingConfig(envelope, save = true) {
        if (this.pendingConfig)
            throw new Error('Pending config already exists')
        const updates = buildUpdates(envelope.timestamp, this.config, envelope.config)
        if (updates.size === 0)
            throw new Error('No updates found in pending config')
        this.pendingConfig = envelope
        if (save)
            fs.writeFileSync(oraclePendingConfigPath, JSON.stringify(envelope.toPlainObject(), null, 2))
    }

    /**
     * @type {Node[]}
     */
    get nodes() {
        return this.config.nodes
    }

    get network() {
        return this.config.network
    }

    get horizonUrl() {
        return this.appConfig.networkHorizonUrl
    }

    /**
     * @param {string} oracleId - oracle id
     * @returns {ContractConfig}
     */
    getContractConfig(oracleId) {
        return __getContractConfig(this.config, oracleId)
    }

    getAssets(oracleId, includePending = false) {
        if (!(includePending && this.pendingConfig))
            return __getContractConfig(this.config, oracleId).assets

        return __getContractConfig(this.pendingConfig.config, oracleId).assets
    }

    get statistics() {
        const connectionIssues = connectionManager.issues || []
        if (this.config && this.config.isValid) {
            const dataSources = [...this.config.contracts.values()].map(c => c.dataSource)
            for (const dataSource of dataSources) {
                if (!connectionManager.has(dataSource))
                    connectionIssues.push(`Connection data for data source ${dataSource} not found`)
            }
            if (!connectionManager.has(this.config.network))
                connectionIssues.push(`Connection data for network ${this.config.network} not found`)
        }
        return {
            currentConfigHash: this.config ? this.config.getHash() : null,
            pendingConfigHash: this.pendingConfig ? this.pendingConfig.config.getHash() : null,
            connectionIssues,
            version: container.version
        }
    }
}

module.exports = SettingsManager