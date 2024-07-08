const {mapToPlainObject} = require('@reflector/reflector-shared/utils/map-helper')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const nodesManager = require('../domain/nodes/nodes-manager')
const container = require('./container')

class ContractStatistics {
    constructor(contractId, type) {
        if (!contractId)
            throw new Error('contractId is required')
        this.contractId = contractId
        this.type = type
        this.lastProcessedTimestamp = 0
        this.totalProcessed = 0
        this.submittedTransactions = 0
        this.isInitialized = false
    }

    setLastProcessedTimestamp(timestamp) {
        this.lastProcessedTimestamp = timestamp
        this.totalProcessed++
    }

    incSubmittedTransactions() {
        this.submittedTransactions++
    }

    setLastContractData(isInitialized) {
        this.isInitialized = isInitialized
    }

    getStatistics() {
        return {
            contractId: this.contractId,
            lastProcessedTimestamp: this.lastProcessedTimestamp,
            totalProcessed: this.totalProcessed,
            submittedTransactions: this.submittedTransactions
        }
    }
}

class OracleStatistics extends ContractStatistics {
    constructor(contractId) {
        super(contractId, ContractTypes.ORACLE)
        this.lastOracleTimestamp = 0
    }

    setLastOracleData(lastOracleTimestamp, isInitialized) {
        this.setLastContractData(isInitialized)
        this.lastOracleTimestamp = lastOracleTimestamp
    }

    getStatistics() {
        return {
            ...super.getStatistics(),
            lastOracleTimestamp: this.lastOracleTimestamp
        }
    }
}

class SubscriptionsStatistics extends ContractStatistics {
    constructor(contractId) {
        super(contractId, ContractTypes.SUBSCRIPTIONS)
        this.lastSubscrioptionId = 0
    }

    setLastSubscriptionsData(lastSubscrioptionId, isInitialized) {
        this.setLastContractData(isInitialized)
        this.lastSubscrioptionId = lastSubscrioptionId
    }

    getStatistics() {
        return {
            ...super.getStatistics(),
            lastSubscrioptionId: this.lastSubscrioptionId
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
     * @type {Map<string, ContractStatistics>}
     */
    __contractStatistics = new Map()

    __getContracStatistics(contractId, type) {
        let contractStatistics = this.__contractStatistics.get(contractId)
        if (!contractStatistics) {
            switch (type) {
                case ContractTypes.ORACLE:
                    contractStatistics = new OracleStatistics(contractId)
                    break
                case ContractTypes.SUBSCRIPTIONS:
                    contractStatistics = new SubscriptionsStatistics(contractId)
                    break
                default:
                    contractStatistics = new ContractStatistics(contractId)
            }
        }
        this.__contractStatistics.set(contractId, contractStatistics)
        return contractStatistics
    }

    setLastProcessedTimestamp(contractId, type, timestamp) {
        const contractStatistics = this.__getContracStatistics(contractId, type)
        contractStatistics.setLastProcessedTimestamp(timestamp)
        this.lastOracleTimestamp = timestamp
        this.totalProcessed++
    }

    incSubmittedTransactions(contractId, type) {
        const contractStatistics = this.__getContracStatistics(contractId, type)
        contractStatistics.incSubmittedTransactions()
        this.submittedTransactions++
    }

    setLastOracleData(contractId, lastOracleTimestamp, isInitialized) {
        const oracleStatistics = this.__getContracStatistics(contractId, ContractTypes.ORACLE)
        oracleStatistics.setLastOracleData(lastOracleTimestamp, isInitialized)
    }

    setLastSubscriptionData(contractId, lastSubscrioptionId, isInitialized) {
        const contractStatistics = this.__getContracStatistics(contractId, ContractTypes.SUBSCRIPTIONS)
        contractStatistics.setLastSubscriptionsData(lastSubscrioptionId, isInitialized)
    }

    getStatistics() {
        const settingsStatistics = container.settingsManager.statistics
        const connectedNodes = nodesManager.getConnectedNodes()
        const contractStatistics = mapToPlainObject(this.__contractStatistics)
        const currentTime = Date.now()
        return {
            startTime: this.startTime,
            uptime: currentTime - this.startTime,
            currentTime,
            lastProcessedTimestamp: this.lastProcessedTimestamp,
            totalProcessed: this.totalProcessed,
            submittedTransactions: this.submittedTransactions,
            connectedNodes,
            oracleStatistics: contractStatistics, //legacy
            contractStatistics,
            ...settingsStatistics
        }
    }

    remove(contractId) {
        this.__contractStatistics.delete(contractId)
    }

    /**
     * Remove all not in list contract statistics
     * @param {string[]} contractIds - contract id
     */
    setContractIds(contractIds) {
        const allKeys = [...this.__contractStatistics.keys()]
        for (const contractId of allKeys) {
            if (contractIds.indexOf(contractId) === -1)
                this.remove(contractId)
        }
    }
}

module.exports = new StatisticsManager()