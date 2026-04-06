const ExchangesPriceProvider = require('@reflector/reflector-exchanges-connector')
const ForexPriceProvider = require('@reflector/reflector-fx-connector')
const StellarProvider = require('@reflector/reflector-stellar-connector')
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

function getProviderByName(name) {
    switch (name) {
        case 'exchanges':
            return new ExchangesPriceProvider()
        case 'forex':
            return new ForexPriceProvider()
        case 'pubnet':
        case 'testnet':
            return new StellarProvider()
        default:
            throw new ValidationError(`unknown provider name: ${name}`)
    }
}

const exchangesDataSourceName = 'exchanges'

/**
 * @type {Map<string, { networkPassphrase: string, sorobanRpc: [string[]], type: string, secret: [string], name: string }>}
 */
const __connections = new Map([
    [exchangesDataSourceName, {
        type: DataSourceTypes.API,
        name: exchangesDataSourceName,
        provider: getProviderByName(exchangesDataSourceName)
    }]
]) //exchanges does not require any configuration, so it is added by default

/**
 * @param {any} dataSourceConfig
 * @returns {any}
 */
function getNormalizedInitOptions(dataSourceConfig) {
    return {
        rpcUrls: dataSourceConfig.sorobanRpc,
        network: dataSourceConfig.networkPassphrase
    }
}

/**
 * @param {DataSource} dataSource - data source
 */
async function __registerConnection(dataSource) {
    if (!dataSource)
        throw new ValidationError('dataSource is required')
    const dataSourceConfig =
        {...dataSource,
            networkPassphrase: networks[dataSource.name] || dataSource.name,
            instance: getProviderByName(dataSource.name)
        }
    __connections.set(dataSource.name, dataSourceConfig)
    if (dataSourceConfig.instance.init)
        await dataSourceConfig.instance.init(getNormalizedInitOptions(dataSourceConfig))
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
    async setDataSources(dataSources) {
        for (const source of dataSources) {
            try {
                await __registerConnection(source)
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
        this.get(exchangesDataSourceName).instance.setGateway(urls, gatewayValidationKey)
    }

    /**
     * @param {string} name - source name
     * @returns {{ networkPassphrase: string, sorobanRpc: [string[]], type: string, secret: [string], name: string}}
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

    dispose() {
        for (const [name, connection] of __connections) {
            if (connection.instance.dispose) {
                try {
                    connection.instance.dispose()
                } catch (err) {
                    logger.error(`Error occurred while disposing data source ${name}: ${err.message}`)
                }
            }
        }
    }
}

module.exports = new DataSourcesManager()