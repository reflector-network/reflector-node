const {createDbConnection} = require('@reflector/reflector-db-connector')
const IssuesContainer = require('@reflector/reflector-shared/models/issues-container')
const {ValidationError} = require('@reflector/reflector-shared')
const DataSourceTypes = require('../models/data-source-types')
const logger = require('../logger')

/**
 * @typedef {import('@reflector/reflector-db-connector').AggregatedTradeResult} AggregatedTradeResult
 * @typedef {import('@reflector/reflector-db-connector').AccountProps} AccountProps
 * @typedef {import('@reflector/reflector-db-connector').Signer} Signer
 * @typedef {import('@reflector/reflector-db-connector').TradeAggregationParams} TradeAggregationParams
 * @typedef {import('../models/data-source')} DataSource
 */

const networks = {
    testnet: 'Test SDF Network ; September 2015',
    pubnet: 'Public Global Stellar Network ; September 2015'
}

/**
 * @type {Map<string, { networkPassphrase: string, sorobanRpc: [string[]], dbConnector: [DbConnector], type: string, secret: [string], name: string }>}
 */
const __connections = new Map()

/**
 * @param {DataSource} dataSource - data source
 */
function __registerConnection(dataSource) {
    if (!dataSource)
        throw new ValidationError('dataSource is required')
    const {name, dbConnection: source, sorobanRpc, secret, type} = dataSource
    switch (type) {
        case DataSourceTypes.DB:
            {
                const networkPassphrase = networks[name] || name
                const dbConnector = createDbConnection({
                    connectionString: source
                })
                __connections.set(name, {networkPassphrase, dbConnector, sorobanRpc, type, name})
            }
            break
        case DataSourceTypes.API:
            if (!secret && name === 'coinmarketcap')
                throw new ValidationError('secret is required')
            __connections.set(name, {type, secret, name})
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
}

module.exports = new DataSourcesManager()
