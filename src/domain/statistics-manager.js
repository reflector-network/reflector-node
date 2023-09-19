const container = require('./container')

class StatisticsManager {
    constructor() {
        this.startTime = Date.now()
        this.oracleData = {
            lastOracleTimestamp: 0,
            isInitialized: false
        }
    }

    lastProcessedTimestamp = 0

    totalProcessed = 0

    submittedTransactions = 0

    setLastProcessedTimestamp(timestamp) {
        this.lastProcessedTimestamp = timestamp
        this.totalProcessed++
    }

    incSubmittedTransactions() {
        this.submittedTransactions++
    }

    setLastOracleData(lastOracleTimestamp, isInitialized) {
        this.oracleData = {
            lastOracleTimestamp,
            isInitialized
        }
    }

    getStatistics() {
        const currentTime = Date.now()
        return {
            startTime: this.startTime,
            uptime: currentTime - this.startTime,
            lastProcessedTimestamp: this.lastProcessedTimestamp,
            totalProcessed: this.totalProcessed,
            submittedTransactions: this.submittedTransactions,
            connectedNodes: container.nodesManager.getConnectedNodes(),
            nodeStatus: container.settingsManager.nodeStatus,
            oracleData: this.oracleData
        }
    }
}

module.exports = StatisticsManager