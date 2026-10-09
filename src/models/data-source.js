const logger = require('../logger')
const DataSourceTypes = require('./data-source-types')

class DataSource {
    constructor(raw) {
        if (!raw) {
            throw new Error('DataSource is undefined')
        }
        this.__setType(raw.type)
        this.__setName(raw.name)
        this.__setSorobanRpc(raw.sorobanRpc)
        this.__setProviders(raw.providers)
    }

    /**
     * @type {string}
     */
    type = null

    /**
     * @type {string[]}
     */
    sorobanRpc = null

    /**
     * @type {string}
     */
    secret = null

    /**
     * @type {string}
     */
    name = null

    __setType(type) {
        switch (type) {
            case DataSourceTypes.DB:
            case DataSourceTypes.API:
                this.type = type
                break
            default:
                throw new Error(`Invalid DataSource type: ${type}`)
        }
    }

    __setName(name) {
        if (!name) {
            throw new Error('DataSource name is undefined')
        }
        this.name = name
    }

    __setSorobanRpc(sorobanRpc) {
        if (this.type === DataSourceTypes.DB && (!Array.isArray(sorobanRpc) || sorobanRpc.length === 0))
            throw new Error('DataSource sorobanRpc is undefined or empty. It is required for DB data sources.')
        this.sorobanRpc = sorobanRpc
    }

    __setProviders(providers) {
        //absent means the connector's own defaults; an array (exchanges) or an object keyed by provider (forex, the
        //Stellar pool providers) reaches the connector as its sources
        if (providers !== undefined && providers !== null) {
            const isArray = Array.isArray(providers)
            if (!isArray && typeof providers !== 'object')
                throw new Error('DataSource providers must be an array or an object')
            if ((isArray ? providers.length : Object.keys(providers).length) === 0)
                logger.warn({msg: 'No providers are defined for data source', source: this.name})
        }
        this.providers = providers
    }
}

module.exports = DataSource