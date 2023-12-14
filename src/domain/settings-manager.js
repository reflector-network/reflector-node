
const fs = require('fs')
const {ValidationError, ConfigEnvelope, buildUpdates, Config} = require('@reflector/reflector-shared')
const AppConfig = require('../models/app-config')
const NodeStatus = require('./node-status')
const nodesManager = require('./nodes/nodes-manager')
const container = require('./container')
const connectionManager = require('./data-sources-manager')

const appConfigPath = './home/app.config.json'
const oracleConfigPath = './home/.config.json'
const oraclePendingConfigPath = './home/.pending.config.json'
const dockerDbPasswordPath = './home/.dockerDbPassword'

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
            throw new Error(`Invalid app config. Issues: ${this.appConfig.issuesString}`)
        }
        this.setAppConfig(this.appConfig)
        //set current config
        const rawConfig = fs.existsSync(oracleConfigPath) ? JSON.parse(fs.readFileSync(oracleConfigPath).toString().trim()) : null
        if (rawConfig) {
            const oraclesConfig = new Config(rawConfig)
            if (!oraclesConfig.isValid)
                throw new Error(`Invalid config. Issues: ${oraclesConfig.issuesString}`)
            this.setConfig(oraclesConfig, false)
        }
        //set pending updates
        const rawPendingConfig = fs.existsSync(oraclePendingConfigPath)
            ? JSON.parse(fs.readFileSync(oraclePendingConfigPath).toString().trim())
            : null
        if (rawPendingConfig) {
            const oraclesPendingConfig = new ConfigEnvelope(rawPendingConfig)
            if (!oraclesPendingConfig.isValid)
                throw new Error(`Invalid config. Issues: ${this.oraclesPendingConfig.issuesString}`)
            this.setPendingConfig(oraclesPendingConfig, false)
        }
    }

    applyPendingUpdate() {
        this.setConfig(this.pendingConfig.config)
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
        const updates = buildUpdates(envelope.timestamp, envelope.config, this.config)
        if (updates.size === 0)
            throw new Error('No updates found in pending config')
        this.pendingConfig = envelope
        if (save)
            fs.writeFileSync(oraclePendingConfigPath, JSON.stringify(envelope.toPlainObject(), null, 2))
    }

    get nodeStatus() {
        return this.config ? NodeStatus.ready : NodeStatus.init
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
        const contractConfig = __getContractConfig(this.config, oracleId)
        const assets = [...contractConfig.assets]
        if (!(includePending && this.pendingConfig))
            return assets

        const pendingConfig = __getContractConfig(this.pendingConfig.config, oracleId)
        const pendingAssets = []
        for (const asset of pendingConfig.assets) {
            if (assets.indexOf(asset) === -1)
                pendingAssets.push(asset)
        }
        return [...assets, ...pendingAssets]
    }
}

module.exports = SettingsManager