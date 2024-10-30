const {buildDAOInitTransaction, buildDAOUnlockTransaction, getContractState, ContractTypes} = require('@reflector/reflector-shared')
const statisticsManager = require('../statistics-manager')
const container = require('../container')
const logger = require('../../logger')
const nodesManager = require('../nodes/nodes-manager')
const {getAccount} = require('../../utils')
const RunnerBase = require('./runner-base')

/**
 * @typedef {import('@reflector/reflector-shared').DAOConfig} DAOConfig
 */

const unlockFrame = 1000 * 60 * 60 * 24 * 7 //1 week

class DAORunner extends RunnerBase {
    constructor(contractId) {
        if (!contractId)
            throw new Error('contractId is required')
        super(contractId)
    }

    async __workerFn(timestamp) {
        /**@type {DAOConfig} */
        const contractConfig = this.__getCurrentContract()
        if (!contractConfig)
            throw new Error(`Config not found for oracle id: ${this.contractId}`)

        const {settingsManager} = container

        const {admin, fee, token, developer} = contractConfig

        //cluster network data
        const {networkPassphrase: network, sorobanRpc} = settingsManager.getBlockchainConnectorSettings()

        //get account info
        const sourceAccount = await getAccount(admin, sorobanRpc)

        const contractState = await getContractState(this.contractId, sorobanRpc)

        logger.trace(`Contract state: lastBallotId: ${Number(contractState.lastBallotId)}, lastUnlock: ${Number(contractState.lastUnlock)}, initialized: ${contractState.isInitialized}, contractId: ${this.contractId}`)
        statisticsManager.setLastDAOData(
            this.contractId,
            Number(contractState.lastTimestamp),
            Number(contractState.lastUnlock),
            contractState.isInitialized
        )

        let updateTxBuilder = null
        if (!contractState.isInitialized) {
            updateTxBuilder = async (account, fee, maxTime) => await buildDAOInitTransaction({
                account,
                network,
                sorobanRpc,
                config: contractConfig,
                fee,
                maxTime,
                decimals: settingsManager.getDecimals(this.contractId)
            })
        } else if (timestamp - (Number(contractState.lastUnlock) * 1000) >= unlockFrame) { //unlock date stored in seconds in the contract instance
            updateTxBuilder = async (account, fee, maxTime) => await buildDAOUnlockTransaction({
                account,
                developer,
                operators: settingsManager.getOperators(),
                network,
                sorobanRpc,
                contractId: this.contractId,
                token,
                fee,
                maxTime,
                timestamp
            })
        } else {
            //nothing to do
            return false
        }

        await this.__buildAndSubmitTransaction(
            updateTxBuilder,
            sourceAccount,
            fee,
            timestamp,
            this.__delay
        )

        return true
    }

    get __timeframe() {
        return 1000 * 60
    }

    __getNextTimestamp(currentTimestamp) {
        return currentTimestamp + this.__timeframe
    }

    get __delay() {
        return 0
    }

    get __contractType() {
        return ContractTypes.DAO
    }
}

module.exports = DAORunner