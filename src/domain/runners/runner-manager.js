const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const logger = require('../../logger')
const ClusterRunner = require('./cluster-runner')
const OracleRunner = require('./oracle-runner')
const SubscriptionsRunner = require('./subscriptions-runner')
const PriceRunner = require('./price-runner')

/**
 * @typedef {import('./runner-base')} RunnerBase
 */

class RunnerManager {
    /**
     * @type {Map<string, RunnerBase>}
     */
    runners = new Map()

    updatesRunner = new ClusterRunner()

    priceRunner = new PriceRunner()

    start() {
        if (!this.updatesRunner.isRunning)
            this.updatesRunner.start()

        if (!this.priceRunner.isRunning)
            this.priceRunner.start()

        for (const runner of this.runners.values()) {
            if (!runner.isRunning)
                runner.start()
        }

        logger.debug('RunnerManager -> started')
    }

    stop() {
        this.updatesRunner.stop()
        this.priceRunner.stop()
        for (const runner of this.runners.values()) {
            runner.stop()
        }
        logger.debug('RunnerManager -> stopped')
    }

    /**
     * @param {Map<string, string>} contracts - contracts id -> contract type
     */
    setContractsIds(contracts) {
        const allRunnerIds = [...this.runners.keys()]
        const allKeys = new Set([...allRunnerIds, ...contracts.keys()])
        for (const contractId of allKeys) {
            if (contracts.has(contractId)) //try to add
                this.add(contractId, contracts.get(contractId))
            else
                this.remove(contractId)
        }
    }

    /**
     * @param {string} contractId - contract id
     * @returns {RunnerBase}
     */
    get(contractId) {
        if (!this.runners.has(contractId))
            throw new Error(`Oracle runner not found for contract id: ${contractId}`)
        return this.runners.get(contractId)
    }

    /**
     * @param {string} contractId - contract id
     * @returns {boolean}
     */
    has(contractId) {
        return this.runners.has(contractId)
    }

    /**
     * @param {string} contractId - contract id
     * @param {string} type - contract type
     * @returns {RunnerBase}
     */
    add(contractId, type) {
        if (this.runners.has(contractId)) //already exists
            return
        let runner = null
        switch (type) {
            case ContractTypes.ORACLE:
                runner = new OracleRunner(contractId)
                logger.debug(`RunnerManager -> add -> oracleRunner ${contractId} added`)
                break
            case ContractTypes.SUBSCRIPTIONS:
                runner = new SubscriptionsRunner(contractId)
                logger.debug(`RunnerManager -> add -> subscriptionsRunner ${contractId} added`)
                break
            default:
                throw new Error(`RunnerManager -> add -> unknown contract type: ${type}`)
        }
        this.runners.set(contractId, runner)
        return runner
    }

    /**
     * @param {string} contractId - contract id
     */
    remove(contractId) {
        if (!this.runners.has(contractId))
            return
        const runner = this.runners.get(contractId)
        runner.stop()
        this.runners.delete(contractId)
    }

    all() {
        return [...this.runners.values()]
    }
}

module.exports = new RunnerManager()