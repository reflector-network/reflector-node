const {createDbConnection} = require('@reflector/reflector-db-connector')
const {setProxy} = require('@reflector/reflector-exchanges-connector')
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

const exchangesDataSourceName = 'exchanges'

/**
 * @type {Map<string, { networkPassphrase: string, sorobanRpc: [string[]], dbConnector: [DbConnector], type: string, secret: [string], name: string }>}
 */
const __connections = new Map([[exchangesDataSourceName, {type: DataSourceTypes.API, name: exchangesDataSourceName}]]) //exchanges is not required any configuration, so it is added by default

/**
 * @param {DataSource} dataSource - data source
 * @param {{ connectionString: string, useCurrent: boolean }} proxy - proxy
 */
function __registerConnection(dataSource, proxy) {
    if (!dataSource)
        throw new ValidationError('dataSource is required')
    const {
        name,
        dbConnection: source,
        sorobanRpc,
        secret,
        type
    } = dataSource
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
            {
                if (!secret && name === 'coinmarketcap')
                    throw new ValidationError('secret is required')
                __connections.set(name, {type, secret, name})
                if (proxy)
                    if (name === exchangesDataSourceName)
                        setProxy(proxy.connectionString, proxy.useCurrent)
                    else
                        logger.warn(`Proxy is not supported for ${name}`)
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
     * @param {{ connectionString: string, useCurrent: boolean }} proxy - proxy
     */
    setDataSources(dataSources, proxy) {
        for (const source of dataSources) {
            try {
                __registerConnection(source, proxy)
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

    getNetwork(name) {
        if (!name)
            throw new Error('name is required')
        const connection = __connections.get(name)
        if (!connection)
            return null
        return connection.networkPassphrase
    }
}

module.exports = new DataSourcesManager()