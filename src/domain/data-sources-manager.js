const fs = require('fs')
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
    pubnet: 'Public Global Stellar Network ; September 2015',
    futurenet: 'Test SDF Future Network ; October 2022'
}

function getProviderByName(name) {
    switch (name) {
        case 'exchanges':
            return new ExchangesPriceProvider()
        case 'forex':
            return new ForexPriceProvider()
        case 'pubnet':
        case 'testnet':
        case 'futurenet':
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
        //`instance`, the key every reader uses: under the old `provider` key a node that did not list exchanges in its
        //app config threw on the gateway hand-off, on price fetches and on dispose
        instance: getProviderByName(exchangesDataSourceName)
    }]
]) //exchanges does not require any configuration, so it is added by default

/**
 * Maps the node's three gateway states onto the connector's. The connector reads `[]` as "no gateways configured"
 * (the node synthesises exactly that on first boot), so configured-but-none-usable goes over as a list whose only
 * entry is unusable, which the connector refuses to route instead of going direct
 * @param {string[]|null} urls - validated gateway urls: null none configured, [] none usable
 * @returns {Array<string|null>|null}
 */
function toConnectorGateways(urls) {
    if (!urls)
        return null
    if (urls.length === 0)
        return [null]
    return urls
}

/**
 * @param {any} dataSourceConfig
 * @param {string} cacheDir
 * @returns {any}
 */
function getNormalizedInitOptions(dataSourceConfig, cacheDir) {
    return {
        rpcUrls: dataSourceConfig.sorobanRpc,
        network: dataSourceConfig.networkPassphrase,
        cacheDir
    }
}

/**
 * @param {DataSource} dataSource - data source
 * @param {string} cacheDir - directory for connector caches
 */
async function __registerConnection(dataSource, cacheDir) {
    if (!dataSource)
        throw new ValidationError('dataSource is required')
    const dataSourceConfig =
        {...dataSource,
            networkPassphrase: networks[dataSource.name] || dataSource.name,
            instance: getProviderByName(dataSource.name)
        }
    __connections.set(dataSource.name, dataSourceConfig)
    if (dataSourceConfig.instance.init)
        await dataSourceConfig.instance.init(getNormalizedInitOptions(dataSourceConfig, cacheDir))
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
     * @param {string} homeDir - node home directory; a `cache` subfolder is used for connector on-disk caches
     */
    async setDataSources(dataSources, homeDir) {
        const cacheDir = `${homeDir}/cache`
        fs.mkdirSync(cacheDir, {recursive: true})
        for (const source of dataSources) {
            try {
                await __registerConnection(source, cacheDir)
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
     * @param {{urls: ?Array<string>, gatewayValidationKey: string}} gateways - gateways list
     */
    setGateways(gateways) {
        const {urls, gatewayValidationKey} = gateways || {}
        const exchanges = this.get(exchangesDataSourceName)
        if (!exchanges?.instance?.setGateway) {
            //a backstop only: the default entry above always carries an instance, so reaching this is a defect
            logger.error({msg: 'Exchanges data source has no gateway-capable instance; the gateway list was not applied'})
            return
        }
        exchanges.instance.setGateway(toConnectorGateways(urls), gatewayValidationKey)
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
                    logger.error({msg: 'Error occurred while disposing data source', name, err: err.message})
                }
            }
        }
    }
}

module.exports = new DataSourcesManager()