const fs = require('fs')
const {ValidationError, ConfigEnvelope, buildUpdates, Config} = require('@reflector/reflector-shared')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const AppConfig = require('../models/app-config')
const logger = require('../logger')
const {importRSAKey} = require('../utils/crypto-helper')
const nonceManager = require('../ws-server/nonce-manager')
const runnerManager = require('./runners/runner-manager')
const nodesManager = require('./nodes/nodes-manager')
const container = require('./container')
const dataSourceManager = require('./data-sources-manager')
const statisticsManager = require('./statistics-manager')

const appConfigPath = `${container.homeDir}/app.config.json`
const clusterConfigPath = `${container.homeDir}/.config.json`
const clusterPendingConfigPath = `${container.homeDir}/.pending.config.json`

/**
 * @typedef {import('@reflector/reflector-shared').Node} Node
 * @typedef {import('@reflector/reflector-shared').OracleConfig} OracleConfig
 * @typedef {import('@reflector/reflector-shared').SubscriptionsConfig} SubscriptionsConfig
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

async function normalizeAppConfig(config) {
    if (!config || !config.rsaKey)
        return
    config.rsaKeyObject = await importRSAKey(Buffer.from(config.rsaKey, 'base64'))
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

    async init() {
        //set app config
        if (!fs.existsSync(appConfigPath))
            throw new Error('Config file not found')
        const rawAppConfig = JSON.parse(fs.readFileSync(appConfigPath).toString().trim())
        //need to import rsa key here, because it requires async operation
        await normalizeAppConfig(rawAppConfig)
        this.appConfig = new AppConfig(rawAppConfig)
        if (!this.appConfig.isValid) {
            //shutdown the app if app config is invalid
            throw new Error(`Invalid app config. Issues: ${this.appConfig.issuesString}`)
        }
        this.setAppConfig(this.appConfig)

        //set current config
        const rawConfig = fs.existsSync(clusterConfigPath)
            ? JSON.parse(fs.readFileSync(clusterConfigPath).toString().trim())
            : null
        if (rawConfig) {
            const clusterConfig = new Config(rawConfig)
            if (!clusterConfig.isValid) {
                logger.error(`Invalid config. Config will not be assigned. Issues: ${clusterConfig.issuesString}`)
            } else
                this.setConfig(clusterConfig, null, false)
        }
        //set pending updates
        const rawPendingConfig = fs.existsSync(clusterPendingConfigPath)
            ? JSON.parse(fs.readFileSync(clusterPendingConfigPath).toString().trim())
            : null
        if (rawPendingConfig) {
            const clusterPendingConfig = new ConfigEnvelope(rawPendingConfig)
            if (!clusterPendingConfig.config.isValid) {
                logger.error(`Invalid pending config. Config will not by assigned. Issues: ${clusterPendingConfig.issuesString}`)
            } else
                this.setPendingConfig(clusterPendingConfig, null, false)
        }
    }

    setTrace(trace) {
        this.appConfig.trace = !!trace
        logger.setTrace(this.appConfig.trace)
        fs.writeFileSync(appConfigPath, JSON.stringify(this.appConfig.toPlainObject(), null, 2))
    }

    applyPendingUpdate(nonce) {
        this.setConfig(this.pendingConfig.config, nonce)
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
    setAppConfig(config) {
        this.appConfig = config
        logger.setTrace(this.appConfig.trace)
        dataSourceManager.setDataSources([...config.dataSources.values()], config.gateway)
    }

    /**
     * @param {Config} config - config
     * @param {number} nonce - nonce for the config
     * @param {boolean} [save] - save config to file
     */
    setConfig(config, nonce, save = true) {
        this.config = config
        if (!this.config.isValid)
            return
        const contracts = new Map([...config.contracts.values()].map(c => ([c.contractId, c.type])))
        runnerManager.setContracts(contracts)
        nodesManager.setNodes(config.nodes)
        statisticsManager.setContractIds([...config.contracts.keys()])
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
     * @type {Node[]}
     */
    get nodes() {
        return this.config.nodes
    }

    get network() {
        return this.config.network
    }

    /**
     * @param {string} contractId - contract id
     * @returns {OracleConfig|SubscriptionsConfig}
     */
    getContractConfig(contractId) {
        return __getContractConfig(this.config, contractId)
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
     * @param {string} contractId - contract id
     * @param {boolean} includePending - include pending updates assets
     * @returns {Asset[]}
     */
    getAssets(contractId, includePending = false) {
        if (!(includePending && this.pendingConfig))
            return __getContractConfig(this.config, contractId).assets

        return __getContractConfig(this.pendingConfig.config, contractId).assets
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
        if (!dbConnector)
            throw new Error(`Blockchain connector not found: ${this.config.network}`)
        return {networkPassphrase, sorobanRpc, blockchainConnector: dbConnector}
    }

    /**
     * Returns node settings statistics
     */
    get statistics() {
        const connectionIssues = dataSourceManager.issues || []
        if (this.config && this.config.isValid) {
            const dataSources = [...this.config.contracts.values()].filter(c => c.type === ContractTypes.ORACLE).map(c => c.dataSource)
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
}

module.exports = SettingsManager