const {mapToPlainObject} = require('@reflector/reflector-shared/utils/map-helper')
const logger = require('../logger')
const nodesManager = require('../domain/nodes/nodes-manager')
const container = require('./container')

class OracleStatistics {
    constructor(oracleId) {
        if (!oracleId)
            throw new Error('oracleId is required')
        this.oracleId = oracleId
        this.lastProcessedTimestamp = 0
        this.totalProcessed = 0
        this.submittedTransactions = 0
        this.lastOracleTimestamp = 0
        this.isInitialized = false
    }

    setLastProcessedTimestamp(timestamp) {
        this.lastProcessedTimestamp = timestamp
        this.totalProcessed++
    }

    incSubmittedTransactions() {
        this.submittedTransactions++
    }

    setLastOracleData(lastOracleTimestamp, isInitialized) {
        this.lastOracleTimestamp = lastOracleTimestamp
        this.isInitialized = isInitialized
    }

    getStatistics() {
        return {
            oracleId: this.oracleId,
            lastProcessedTimestamp: this.lastProcessedTimestamp,
            totalProcessed: this.totalProcessed,
            submittedTransactions: this.submittedTransactions,
            lastOracleTimestamp: this.lastOracleTimestamp
        }
    }
}

class StatisticsManager {
    constructor() {
        this.startTime = Date.now()
        this.lastProcessedTimestamp = 0
        this.totalProcessed = 0
        this.submittedTransactions = 0
    }

    /**
     * @type {Map<string, OracleStatistics>}
     */
    __oracleStatistics = new Map()

    __getOracleStatistics(oracleId) {
        let oracleStatistics = this.__oracleStatistics.get(oracleId)
        if (!oracleStatistics) {
            oracleStatistics = new OracleStatistics(oracleId)
            this.__oracleStatistics.set(oracleId, oracleStatistics)
        }
        return oracleStatistics
    }

    setLastProcessedTimestamp(oracleId, timestamp) {
        const oracleStatistics = this.__getOracleStatistics(oracleId)
        oracleStatistics.setLastProcessedTimestamp(timestamp)
        this.lastOracleTimestamp = timestamp
        this.totalProcessed++
    }

    incSubmittedTransactions(oracleId) {
        const oracleStatistics = this.__getOracleStatistics(oracleId)
        oracleStatistics.incSubmittedTransactions()
        this.submittedTransactions++
    }

    setLastOracleData(oracleId, lastOracleTimestamp, isInitialized) {
        const oracleStatistics = this.__getOracleStatistics(oracleId)
        oracleStatistics.setLastOracleData(lastOracleTimestamp, isInitialized)
    }

    getStatistics() {
        const settingsStatistics = container.settingsManager.statistics
        const connectedNodes = nodesManager.getConnectedNodes()
        const oracleStatistics = mapToPlainObject(this.__oracleStatistics)
        const currentTime = Date.now()
        return {
            startTime: this.startTime,
            uptime: currentTime - this.startTime,
            currentTime,
            lastProcessedTimestamp: this.lastProcessedTimestamp,
            totalProcessed: this.totalProcessed,
            submittedTransactions: this.submittedTransactions,
            connectedNodes,
            oracleStatistics,
            ...settingsStatistics
        }
    }
}

module.exports = StatisticsManager