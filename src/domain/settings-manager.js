/**
 * @typedef {import('../models/config')} Config
 * @typedef {import('../models/contract/updates/update-base')} UpdateBase
 */

const {EventEmitter} = require('events')
const fs = require('fs')
const {StrKey} = require('soroban-client')
const UpdateType = require('../models/contract/updates/update-type')
const ValidationError = require('../models/validation-error')
const Config = require('../models/config')
const {buildUpdate} = require('./updates-helper')
const NodeStatus = require('./node-status')

const configPath = './home/app.config.json'
const dockerDbPasswordPath = './home/.dockerDbPassword'

class PrivateField {
    constructor(name, isEditable = false) {
        this.name = name
        this.isEditable = isEditable
    }
}

const configPrivateFields = [new PrivateField('dockerDbPassword'), new PrivateField('dbConnectionString', true), new PrivateField('handshakeTimeout')]
const contractSettingsPrivateFields = [new PrivateField('pendingUpdate')]

function __setPrivateFields(dest, source, privateFields) {
    for (const field of privateFields)
        if (!field.isEditable || !dest[field.name]) //if field is not defined or is not editable, we should use old value
            dest[field.name] = source[field.name] || null
}

function __removePrivateFields(obj, privateFields) {
    if (!obj)
        return
    for (const field of privateFields)
        delete obj[field.name]
}

function __getDockerDbPassword() {
    if (!fs.existsSync(dockerDbPasswordPath)) {
        return null
    }
    return fs.readFileSync(dockerDbPasswordPath).toString().trim()
}

function __getSecret() {
    const secret = process.env.SECRET
    if (!(secret && StrKey.isValidEd25519SecretSeed(secret)))
        throw new Error('SECRET is not defined or invalid. Provide valid secret in SECRET env variable. It should be valid Ed25519 secret seed.')
    return secret
}

function __getRawConfig() {
    if (!fs.existsSync(configPath))
        return {}
    return JSON.parse(fs.readFileSync(configPath).toString().trim())
}

class SettingsManager extends EventEmitter {

    static EVENTS = {
        NODES_UPDATED: 'nodes-updated',
        NODES_PERIOD_UPDATED: 'nodes-period-updated',
        NODES_ASSETS_UPDATED: 'nodes-assets-updated',
        CONTRACT_SETTINGS_UPDATED: 'contract-settings-updated'
    }

    constructor() {
        super()
        const secret = __getSecret()
        const dockerDbPassword = __getDockerDbPassword()
        const rawConfig = __getRawConfig()

        this.__config = new Config(rawConfig, secret, dockerDbPassword)
    }

    /**
     * Update node url
     * @param {string} pubkey - node pubkey
     * @param {string} url - node url
     */
    updateNodeUrl(pubkey, url) {
        this.__checkIfConfigIsValid()
        for (const node of this.nodeAddresses) {
            if (node.pubkey === pubkey)
                if (node.url === url)
                    return
                else {
                    node.url = url
                    this.__saveConfig()
                    break
                }
        }
    }

    /**
     * @param {any} rawUpdate - the update object
     */
    setUpdate(rawUpdate) {
        this.__checkIfConfigIsValid()
        if (this.__config.contractSettings.pendingUpdate)
            throw new ValidationError('Pending update already exist')
        if (!rawUpdate.timestamp)
            throw new ValidationError('Timestamp is not defined')
        const update = buildUpdate(rawUpdate, this.__config.contractSettings.network)
        switch (update.type) {
            case UpdateType.ASSETS:
                update.assets.forEach(asset => {
                    if (update.assets.filter(a => a.type === asset.type && a.code === asset.code) > 1)
                        throw new ValidationError(`Asset ${asset.code} is duplicated`)
                    if (this.__config.contractSettings.assets.findIndex(a => a.type === asset.type && a.code === asset.code) >= 0)
                        throw new ValidationError(`Asset ${asset.code} already exist`)
                    if (this.__config.contractSettings.baseAsset.type === asset.type
                        && this.__config.contractSettings.baseAsset.code === asset.code)
                        throw new ValidationError(`Asset ${asset.code} is base asset`)
                })
                break
            case UpdateType.NODES: {
                update.nodes.forEach(node => {
                    if (!StrKey.isValidEd25519PublicKey(node.pubkey))
                        throw new ValidationError(`Node ${node.pubkey} is invalid`)
                    if (update.nodes.filter(n => n.pubkey === node.pubkey) > 1)
                        throw new ValidationError(`Node ${node.pubkey} is duplicated`)
                })
                break
            }
            case UpdateType.PERIOD:
                if (update.period <= this.__config.contractSettings.timeframe)
                    throw new ValidationError('Invalid period')
                break
            default:
                throw new ValidationError('Invalid update type')
        }
        this.__config.contractSettings.pendingUpdate = update
        this.__saveConfig()
    }

    //we don't allow to have multiple pending updates, so we can update config by pending update
    applyUpdate() {
        let event = null
        this.__checkIfConfigIsValid()
        if (!this.__config.contractSettings.pendingUpdate)
            throw new Error('Pending update do not exist')
        switch (this.__config.contractSettings.pendingUpdate.type) {
            case UpdateType.ASSETS: {
                this.__config.contractSettings.assets.push(...this.__config.contractSettings.pendingUpdate.assets)
                event = SettingsManager.EVENTS.NODES_ASSETS_UPDATED
                break
            }
            case UpdateType.PERIOD: {
                this.__config.contractSettings.period = this.__config.contractSettings.pendingUpdate.period
                event = SettingsManager.EVENTS.NODES_PERIOD_UPDATED
                break
            }
            case UpdateType.NODES: {
                const updateNodes = this.__config.contractSettings.pendingUpdate.nodes
                const currentNodes = this.__config.contractSettings.nodes
                const nodeAddresses = this.__config.nodes
                updateNodes.forEach(node => {
                    if (node.remove) {
                        //try remove from contract settings
                        const index = currentNodes.findIndex(pubkey => pubkey === node.pubkey)
                        if (index >= 0)
                            currentNodes.splice(index, 1)
                        const nodeAddress = nodeAddresses.findIndex(n => n.pubkey === node.pubkey)
                        if (nodeAddress >= 0)
                            nodeAddresses.splice(nodeAddress, 1)
                        return
                    }
                    if (!currentNodes.includes(node.pubkey)) {
                        currentNodes.push(node.pubkey)
                    }
                    //try add to addresses
                    const nodeAddress = nodeAddresses.find(n => n.pubkey === node.pubkey)
                    if (!nodeAddress)
                        nodeAddresses.push({pubkey: node.pubkey, url: node.url})
                    else if (nodeAddress.url !== node.url)
                        nodeAddress.url = node.url
                })
                event = SettingsManager.EVENTS.NODES_UPDATED
                break
            }
            default:
                throw new Error('Invalid update type')
        }
        this.__config.contractSettings.pendingUpdate = null
        this.__saveConfig()
        if (event)
            this.emit(event)
    }

    get nodeStatus() {
        return this.__config.isValid ? NodeStatus.ready : NodeStatus.init
    }

    get contractSettings() {
        return this.config.contractSettings
    }

    get config() {
        return this.__config
    }

    get nodeAddresses() {
        return this.config.nodes
    }

    getAssets(includePending = false) {
        let assets = [...this.contractSettings.assets]
        if (includePending && this.contractSettings.pendingUpdate && this.contractSettings.pendingUpdate.type === UpdateType.ASSETS)
            assets = [...assets, ...this.contractSettings.pendingUpdate.assets]
        return assets
    }

    getConfigForClient() {
        const config = this.config.toPlainObject()
        __removePrivateFields(config, configPrivateFields)
        __removePrivateFields(config.contractSettings, contractSettingsPrivateFields)
        return config
    }

    getContractSettingsForClient() {
        const contractSettings = this.config.contractSettings.toPlainObject()
        __removePrivateFields(contractSettings, contractSettingsPrivateFields)

        const nodes = contractSettings.nodes
        contractSettings.nodes = nodes.map(node => ({
            pubkey: node,
            url: this.config.nodes.find(n => n.pubkey === node)?.url
        }))
        return contractSettings
    }

    updateConfig(rawConfig) {
        //set private fields here to avoid validation errors
        __setPrivateFields(rawConfig, this.__config, configPrivateFields)
        __setPrivateFields(rawConfig.contractSettings, this.__config.contractSettings, contractSettingsPrivateFields)
        //set secret we received from env
        const config = new Config(rawConfig, this.__config.secret, this.__config.dockerDbPassword)
        if (!config.isValid) {
            const error = new ValidationError('Invalid config')
            error.details = {issues: config.issues}
            throw error
        }
        this.__config = config
        this.__saveConfig()
        this.emit(SettingsManager.EVENTS.CONTRACT_SETTINGS_UPDATED)
    }

    __checkIfConfigIsValid() {
        if (!this.config.isValid)
            throw new ValidationError('Config is not in ready state')
    }

    __saveConfig() {
        fs.writeFileSync(configPath, JSON.stringify(this.config.toPlainObject(), null, 2))
    }
}

module.exports = SettingsManager