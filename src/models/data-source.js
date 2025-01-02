const DataSourceTypes = require('./data-source-types')

class DataSource {
    constructor(raw) {
        if (!raw) {
            throw new Error('DataSource is undefined')
        }
        this.__setType(raw.type)
        this.__setName(raw.name)
        this.__setSorobanRpc(raw.sorobanRpc)
        this.__setSecret(raw.secret)
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

    __setSecret(secret) {
        this.secret = secret
    }
}

module.exports = DataSource