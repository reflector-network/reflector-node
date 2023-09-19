/**
 * @typedef {import('./updates/update-base')} UpdateBase
 */

const {StrKey} = require('soroban-client')
const {isValidContractId} = require('../../utils/contractId-helper')
const {buildUpdate} = require('../../domain/updates-helper')
const ConfigBase = require('../config-base')
const Asset = require('../assets/asset')

class ContractConfig extends ConfigBase {
    constructor(raw) {
        super()
        if (!raw) {
            this.__addConfigIssue(`settings: ${ConfigBase.notDefined}`)
            return
        }

        this.admin = !(raw.admin && StrKey.isValidEd25519PublicKey(raw.admin)) ? this.__addConfigIssue(`admin: ${ConfigBase.invalidOrNotDefined}`) : raw.admin
        this.oracleId = !(raw.oracleId && isValidContractId(raw.oracleId)) ? this.__addConfigIssue(`oracleId: ${ConfigBase.invalidOrNotDefined}`) : raw.oracleId
        this.horizon = !(raw.horizon && raw.horizon.length > 0) ? this.__addConfigIssue(`horizon: ${ConfigBase.invalidOrNotDefined}`) : raw.horizon
        this.network = !(raw.network && raw.network.length > 0) ? this.__addConfigIssue(`network: ${ConfigBase.invalidOrNotDefined}`) : raw.network
        this.decimals = !(raw.decimals && raw.decimals > 0 && !isNaN(raw.decimals)) ? this.__addConfigIssue(`decimals: ${ConfigBase.invalidOrNotDefined}`) : raw.decimals
        this.timeframe = !(raw.timeframe && raw.timeframe > 0 && !isNaN(raw.timeframe)) ? this.__addConfigIssue(`timeframe: ${ConfigBase.invalidOrNotDefined}`) : raw.timeframe
        this.period = !(raw.period && !isNaN(raw.period) && raw.period > raw.timeframe) ? this.__addConfigIssue(`period: ${ConfigBase.invalidOrNotDefined}`) : raw.period
        this.fee = !(raw.fee && raw.fee > 0 && !isNaN(raw.fee)) ? this.__addConfigIssue(`fee: ${ConfigBase.invalidOrNotDefined}`) : raw.fee

        this.__assignBaseAsset(raw.baseAsset)

        this.__assignAssets(raw.assets)

        this.__assignNodes(raw.nodes)

        this.__assignUpdate(raw.pendingUpdate)
    }

    __assignBaseAsset(asset) {
        try {
            if (!asset)
                throw new Error(ConfigBase.notDefined)
            //check if array and length > 0
            this.baseAsset = new Asset(asset.type, asset.code, this.network)
        } catch (err) {
            this.__addConfigIssue(`baseAsset: ${err.message}`)
        }
    }

    __assignAssets(assets) {
        try {
            if (!(assets && Array.isArray(assets) && assets.length > 0))
                throw new Error(ConfigBase.invalidOrNotDefined)
            this.assets = assets.map(asset => new Asset(asset.type, asset.code, this.network))
        } catch (err) {
            this.__addConfigIssue(`assets: ${err.message}`)
        }
    }

    __assignNodes(nodes) {
        try {

            if (!(nodes && Array.isArray(nodes) && nodes.length > 0))
                throw new Error(ConfigBase.invalidOrNotDefined)
            nodes.forEach(node => {
                if (!(node && StrKey.isValidEd25519PublicKey(node)))
                    throw new Error(`Invalid node ${node}`)
            })
            const uniquePubkeys = new Set(nodes.map(node => node))
            if (uniquePubkeys.size !== nodes.length)
                throw new Error('Contains duplicates')
            this.nodes = nodes
        } catch (err) {
            this.__addConfigIssue(`nodes: ${err.message}`)
        }
    }

    __assignUpdate(update) {
        if (!update)
            return
        try {
            if (!this.network)
                throw new Error(`Network is not defined. Can't build update`)
            this.pendingUpdate = buildUpdate(update, this.network)
        } catch (err) {
            this.__addConfigIssue(`pending update: ${err.message}`)
        }
    }

    /**
     * @type {string}
     */
    admin

    /**
     * @type {string}
     */
    oracleId

    /**
     * @type {string}
     */
    horizon

    /**
     * @type {string}
     */
    network

    /**
     * @type {Asset}
     */
    baseAsset

    /**
     * @type {number}
     */
    decimals

    /**
     * @type {string[]}
     */
    nodes

    /**
     * @type {Asset[]}
     */
    assets

    /**
     * @type {number}
     */
    timeframe

    /**
     * @type {number}
     */
    period

    /**
     * @type {number}
     */
    fee

    /**
     * @type {UpdateBase}
     */
    pendingUpdate

    toPlainObject() {
        return {
            admin: this.admin,
            oracleId: this.oracleId,
            horizon: this.horizon,
            network: this.network,
            baseAsset: this.baseAsset?.toPlainObject(),
            decimals: this.decimals,
            nodes: this.nodes,
            assets: this.assets?.map(asset => asset.toPlainObject()),
            timeframe: this.timeframe,
            period: this.period,
            pendingUpdate: this.pendingUpdate?.toPlainObject(),
            fee: this.fee
        }
    }
}

module.exports = ContractConfig