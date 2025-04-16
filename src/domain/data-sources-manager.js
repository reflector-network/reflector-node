const {setGateway: setDexGateways} = require('@reflector/reflector-exchanges-connector')
const {setGateway: setForexGateways} = require('@reflector/reflector-fx-connector')
const {ValidationError, IssuesContainer} = require('@reflector/reflector-shared')
const DataSourceTypes = require('../models/data-source-types')
const logger = require('../logger')

/**
 * @typedef {import('@reflector/reflector-stellar-connector').AggregatedTradeResult} AggregatedTradeResult
 * @typedef {import('@reflector/reflector-stellar-connector').AccountProps} AccountProps
 * @typedef {import('@reflector/reflector-stellar-connector').Signer} Signer
 * @typedef {import('@reflector/reflector-stellar-connector').TradeAggregationParams} TradeAggregationParams
 * @typedef {import('../models/data-source')} DataSource
 */

const networks = {
    testnet: 'Test SDF Network ; September 2015',
    pubnet: 'Public Global Stellar Network ; September 2015'
}

const exchangesDataSourceName = 'exchanges'

/**
 * @type {Map<string, { networkPassphrase: string, sorobanRpc: [string[]], type: string, secret: [string], name: string }>}
 */
const __connections = new Map([[exchangesDataSourceName, {type: DataSourceTypes.API, name: exchangesDataSourceName}]]) //exchanges is not required any configuration, so it is added by default

/**
 * @param {DataSource} dataSource - data source
 */
function __registerConnection(dataSource) {
    if (!dataSource)
        throw new ValidationError('dataSource is required')
    const {
        name,
        sorobanRpc,
        secret,
        type,
        providers
    } = dataSource
    switch (type) {
        case DataSourceTypes.DB:
            {
                const networkPassphrase = networks[name] || name
                __connections.set(name, {networkPassphrase, sorobanRpc, type, name})
            }
            break
        case DataSourceTypes.API:
            {
                __connections.set(name, {type, secret, name, providers})
            }
            break
        default:
            throw new ValidationError(`invalid dataSource type: ${type}`)
    }
}

function __deleteConnection(name) {
    if (!name)
        throw new Error('name is required')
    const sourceData = __connections.get(name)
    if (!sourceData)
        return
    __connections.delete(name)
}

class DataSourcesManager extends IssuesContainer {
    /**
     * @param {DataSource[]} dataSources - data sources
     */
    setDataSources(dataSources) {
        for (const source of dataSources) {
            try {
                __registerConnection(source)
            } catch (err) {
                let errorMessage = err.message
                if (!(err instanceof ValidationError))
                    errorMessage = 'issue registering data source. Check logs for details'
                this.__addIssue(`${source.name}: ${errorMessage}`)
                logger.error(err)
            }
        }
    }

    /**
     * @param {{urls: string[], gatewayValidationKey: string}} gateways - gateways list
     */
    setGateways(gateways) {
        const {urls, gatewayValidationKey} = gateways || {}
        setDexGateways(urls, gatewayValidationKey)
        setForexGateways(urls, gatewayValidationKey)
    }

    /**
     * @param {string} name - source name
     * @returns {{ networkPassphrase: string, sorobanRpc: [string[]], dbConnector: [DbConnector], type: string, secret: [string], name: string}}
     */
    get(name) {
        if (!name)
            throw new Error('name is required')
        return __connections.get(name)
    }

    /**
     * @param {string} name - source name
     * @returns {boolean}
     */
    has(name) {
        if (!name)
            throw new Error('name is required')
        return __connections.has(name)
    }

    getNetwork(name) {
        if (!name)
            throw new Error('name is required')
        const connection = __connections.get(name)
        if (!connection)
            return null
        return connection.networkPassphrase
    }

    isStellarSource(name) {
        if (!name)
            throw new Error('name is required')
        const connection = __connections.get(name)
        if (!connection)
            return false
        return connection.type === DataSourceTypes.DB
    }
}

module.exports = new DataSourcesManager()