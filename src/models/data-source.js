const DataSourceTypes = require('./data-source-types')

class DataSource {
    constructor(raw) {
        if (!raw) {
            throw new Error('DataSource is undefined')
        }
        this.__setType(raw.type)
        this.__setName(raw.name)
        this.__setDbConnection(raw.dbConnection)
        this.__setHorizonUrl(raw.horizonUrl)
        this.__setSecret(raw.secret)
    }

    /**
     * @type {string}
     */
    type = null

    /**
     * @type {string}
     */
    dbConnection = null

    /**
     * @type {string}
     */
    horizonUrl = null

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

    __setDbConnection(dbConnection) {
        if (!dbConnection && this.type === DataSourceTypes.DB) {
            throw new Error('DataSource dbConnection is undefined')
        }
        this.dbConnection = dbConnection
    }

    __setName(name) {
        if (!name) {
            throw new Error('DataSource name is undefined')
        }
        this.name = name
    }

    __setHorizonUrl(horizonUrl) {
        this.horizonUrl = horizonUrl
    }

    __setSecret(secret) {
        if (!secret && this.type === DataSourceTypes.API) {
            throw new Error('DataSource secret is undefined. It is required for API data sources')
        }
        this.secret = secret
    }
}

module.exports = DataSource