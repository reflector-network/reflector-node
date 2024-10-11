/*eslint-disable class-methods-use-this */
const {Account, Transaction} = require('@stellar/stellar-sdk')
const {normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const MessageTypes = require('../../ws-server/handlers/message-types')
const nodesManager = require('../nodes/nodes-manager')
const {submitTransaction, txTimeoutMessage} = require('../../utils')
const statisticsManager = require('../statistics-manager')

/**
 * @typedef {import('@reflector/reflector-shared').PendingTransactionBase} PendingTransactionBase
 * @typedef {import('@stellar/stellar-sdk').xdr.DecoratedSignature} DecoratedSignature
 * @typedef {import('@stellar/stellar-sdk').SorobanRpc.Api.GetSuccessfulTransactionResponse} SuccessfulTransactionResponse
 * @typedef {import('@reflector/reflector-shared').ContractConfigBase} ContractConfigBase
 */

/**
 * @param {string} contractId - oracle id
 * @param {PendingTransactionBase} tx - transaction
 * @returns {any}
 */
function getSignatureMessage(contractId, tx) {
    return {
        type: MessageTypes.SIGNATURE,
        data: {
            contractId,
            hash: tx.hashHex,
            signature: tx.signatures[0].toXDR('hex') //first signature always belongs to the current node
        }
    }
}

/**
 * @param {number} syncTimestamp - sync timestamp in milliseconds
 * @param {number} iteration - iteration
 * @returns {number} - max time in seconds
 */
function getMaxTime(syncTimestamp, iteration) {
    const maxTime = syncTimestamp + (maxSubmitTimeout * iteration)
    return maxTime / 1000 //convert to seconds
}

/**
 * @param {string} contractId - oracle id
 * @param {PendingTransactionBase} tx - transaction
 */
async function broadcastSignature(contractId, tx) {
    await nodesManager.broadcast(getSignatureMessage(contractId, tx))
    logger.debug(`Signature broadcasted. Contract id: ${contractId}, tx type: ${tx.type}, tx hash: ${tx.hashHex}`)
}

/**
 * @param {string} contractId - oracle id
 * @param {string} pubkey - node public key
 * @param {PendingTransactionBase} tx - transaction
 */
async function sendSignature(contractId, pubkey, tx) {
    await nodesManager.sendTo(pubkey, getSignatureMessage(contractId, tx))
    logger.debug(`Signature sent to ${pubkey}. Contract id: ${contractId}, tx type: ${tx.type}, tx hash: ${tx.hashHex}`)
}

/**
 * @param {PendingTransactionBase} tx - transaction
 * @param {number} maxTime - max time in seconds
 * @returns {{tx: PendingTransactionBase, resolve: Function, reject: Function, submitPromise: Promise<any>, iteration: number, status: string}}
 */
function createPendingTransactionObject(tx, maxTime) {
    const pendingTxObject = {tx}
    pendingTxObject.submitPromise = new Promise((resolve, reject) => {
        let isSettled = false

        const timeout = (maxTime * 1000) - Date.now()
        const timeoutId = setTimeout(() => {
            logger.debug(`Transaction timed out. Tx type: ${tx.type}, hash: ${tx.hashHex}, maxTime: ${maxTime}, submitted: ${tx.submitted}, current time: ${Math.floor(Date.now() / 1000)}`)
            tx.isTimedOut = true
            if (tx.submitted) //if the transaction is already submitted, we need to wait for the result
                return
            reject(new Error(txTimeoutMessage))
        }, timeout)

        pendingTxObject.resolve = (value) => {
            if (!isSettled) {
                isSettled = true
                clearTimeout(timeoutId)
                resolve(value)
            }
        }

        pendingTxObject.reject = (reason) => {
            if (!isSettled) {
                isSettled = true
                clearTimeout(timeoutId)
                reject(reason)
            }
        }
    })
    return pendingTxObject
}

/**
 * @returns {{promise: Promise<any>, resolve: Function}}
 */
function createMajorityPromiseData() {
    const majorityPromiseData = {}
    majorityPromiseData.promise = new Promise((resolve) => {
        let isSettled = false

        majorityPromiseData.resolve = (value) => {
            if (!isSettled) {
                isSettled = true
                resolve(value)
            }
        }
    })
    return majorityPromiseData
}

const maxSubmitAttempts = 3
const maxSubmitTimeout = 20000

class RunnerBase {

    constructor(contractId) {
        this.contractId = contractId
    }

    start() {
        const timestamp = normalizeTimestamp(Date.now(), this.__timeframe)
        this.isRunning = true
        //awoid starting before sync time
        setTimeout(() => this.worker(timestamp), this.__getWorkerTimeout(timestamp))
        this.__clearPendingSignatures()
    }

    syncTimeframe = 1000 * 5 //5 seconds

    /**
     * @param {string} txHash - transaction hash
     * @param {DecoratedSignature} signature - transaction signature
     * @param {string} from - node public key
     */
    addSignature(txHash, signature, from) {
        //if the transaction is not the pending transaction, add the signature to the pending signatures list
        if (this.__pendingTransaction?.tx.hashHex !== txHash) {
            /**@type {timestamp: number, signatures: DecoratedSignature[]} */
            const signaturesData =
                this.__pendingSignatures[txHash] = this.__pendingSignatures[txHash] || {timestamp: Date.now(), signatures: []}
            if (!signaturesData.signatures.find(s => s.hint().equals(signature.hint())))
                signaturesData.signatures.push(signature)
            logger.debug(`Signature added to the pending signatures. ${this.__contractInfo}, node: ${from}, tx hash: ${txHash}`)
            return
        }
        this.__pendingTransaction.tx.addSignature(signature)
        logger.debug(`Signature added to the pending transaction. ${this.__contractInfo}, node: ${from}, tx type: ${this.__pendingTransaction.tx.type}, tx hash: ${this.__pendingTransaction.tx.hashHex}`)
        this.__trySubmitTransaction()
    }

    /**
     * @param {string} pubkey - node public key
     */
    async broadcastSignatureTo(pubkey) {
        if (!this.__pendingTransaction)
            return
        await sendSignature(this.contractId, pubkey, this.__pendingTransaction.tx)
    }

    stop() {
        this.isRunning = false
        if (this.__workerTimeout)
            clearTimeout(this.__workerTimeout)
    }

    /**
     * @type {{tx: PendingTransactionBase, resolve: Function, reject: Function, submitPromise: Promise<any>, iteration: number, status: string}}
     */
    __pendingTransaction = null

    /**
     * @type {{[hash: string]: {timestamp: number, signatures: DecoratedSignature[]}}}
     */
    __pendingSignatures = {}

    /**
     * @param {number} timestamp - timestamp
     * @returns {Promise<boolean>} - true if the tx is processed
     */
    __workerFn(timestamp) {
        throw new Error('Not implemented')
    }

    __getWorkerTimeout(timestamp) {
        let timeout = timestamp - Date.now()
        timeout += this.__delay
        return timeout
    }

    async worker(timestamp) {
        if (!this.isRunning)
            return
        try {
            logger.info(`${this.__contractInfo} -> worker, timestamp: ${timestamp}`)
            this.__payloadMajorityData = createMajorityPromiseData()
            const isTxProcessed = await this.__workerFn(timestamp)
            //update last processed timestamp
            if (isTxProcessed && this.contractId)
                statisticsManager.setLastProcessedTimestamp(this.contractId, this.__contractType, timestamp)
        } catch (err) {
            logger.error({err}, `Error in worker, ${this.__contractInfo}, timestamp: ${timestamp}`)
        } finally {
            //TODO: improve resolve logic for other runners
            //only subscriptions runner should resolve the promise every run
            this.__payloadMajorityData.resolve(false)
            const nextTimestamp = this.__getNextTimestamp(timestamp)
            const timeout = this.__getWorkerTimeout(nextTimestamp)
            logger.debug(`Worker timeout: ${timeout}, ${this.__contractInfo}`)
            this.__workerTimeout = setTimeout(() => this.worker(nextTimestamp), timeout)
        }
    }

    /**
     * @param {string} hash - transaction hash
     * @param {PendingTransactionBase} pendingTx - pending transaction
     */
    __assignPendingSignatures(hash, pendingTx) {
        //add pending signatures if any
        const signaturesData = this.__pendingSignatures[hash]
        if (signaturesData)
            for (const signature of signaturesData.signatures)
                pendingTx.addSignature(signature)
        delete this.__pendingSignatures[hash]
    }

    /**
     * @param {PendingTransactionBase} tx - transaction
     * @param {number} maxTime - max time in seconds
     * @returns {{tx: PendingTransactionBase, resolve: Function, reject: Function, submitPromise: Promise<SuccessfulTransactionResponse>}}
     */
    __setPendingTransaction(tx, maxTime) {
        if (this.__pendingTransaction) {
            const {type, timestamp} = this.__pendingTransaction.tx
            const {reject} = this.__pendingTransaction
            logger.warn(`Pending transaction wasn't submitted. ContractId: ${this.contractId || 'cluster'}, tx type: ${type}, tx timestamp: ${timestamp}.`)
            this.__clearPendingTransaction()
            reject(new Error('Pending transaction wasn\'t submitted'))
        }

        const keypair = container.settingsManager.appConfig.keypair

        const signature = keypair.signDecorated(tx.hash)
        tx.addSignature(signature)

        this.__pendingTransaction = createPendingTransactionObject(tx, maxTime)

        this.__assignPendingSignatures(tx.hashHex, tx)
        broadcastSignature(this.contractId, tx)
        return this.__pendingTransaction
    }

    __clearPendingTransaction() {
        logger.debug(`Clear pending transaction. ${this.__contractInfo}. Tx type: ${this.__pendingTransaction?.tx.type}, tx hash: ${this.__pendingTransaction?.tx.hashHex}`)
        this.__pendingTransaction = null
    }

    __clearPendingSignatures() {
        try {
            const allHashes = Object.keys(this.__pendingSignatures)
            for (const hash of allHashes) {
                const signaturesData = this.__pendingSignatures[hash]
                if (signaturesData && Date.now() - signaturesData.timestamp > 60000) //1 minute
                    delete this.__pendingSignatures[hash]
            }
        } catch (err) {
            logger.error({err}, 'Error in __clearPendingSignatures')
        } finally {
            setTimeout(() => this.__clearPendingSignatures(), 60000) //1 minute
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async __trySubmitTransaction() {
        const {settingsManager} = container
        const currentNodesLength = settingsManager.nodes.size
        if (!this.__pendingTransaction || !this.__pendingTransaction.tx.isReadyToSubmit(currentNodesLength))
            return
        this.__payloadMajorityData.resolve(true) //we got the majority, so the payload is the same for the majority of nodes
        const {tx, reject, resolve} = this.__pendingTransaction
        const {networkPassphrase, sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
        try {
            this.__clearPendingTransaction() //clear pending transaction to avoid duplicate submission
            tx.submitted = true
            //sleep for random time from 0 to 1 seconds to avoid simultaneous submissions
            await setTimeout(() => { }, Math.floor(Math.random() * 1000))
            const result = await submitTransaction(
                networkPassphrase,
                sorobanRpc,
                tx,
                tx.getMajoritySignatures(currentNodesLength),
                this.__contractInfo
            )
            resolve(result)
            logger.debug(`Transaction is processed. ${this.__contractInfo}. ${tx.getDebugInfo()}`)
        } catch (e) {
            const error = new Error(`Error in submit worker. Tx type: ${tx?.type}, tx hash: ${tx?.hashHex}, tx fee: ${tx?.transaction.fee}, tx: ${tx.transaction.toXDR()}`)
            error.originalError = e
            reject(e)
        }
    }

    /**
     * @param {function} buildTxFn - build function
     * @param {Account} account - account object
     * @param {number} baseFee - base fee
     * @param {number} timestamp - sync timestamp
     * @param {number} [syncDelay] - sync delay
     * @returns {Promise<SuccessfulTransactionResponse>}
     */
    async __buildAndSubmitTransaction(buildTxFn, account, baseFee, timestamp, syncDelay = 0) {
        const errors = []
        let pendingTx = null
        let response = null

        const {settingsManager} = container

        const syncTimestamp = timestamp + syncDelay

        for (let submitAttempt = 0; submitAttempt < maxSubmitAttempts; submitAttempt++) {
            try {
                const fee = baseFee * Math.pow(4, submitAttempt) //increase fee by 4 times on each try
                const maxTime = getMaxTime(syncTimestamp, submitAttempt + 1)
                logger.debug(`Build transaction. ${this.__contractInfo}, syncTimestamp: ${syncTimestamp} , submitAttempt: ${submitAttempt}, maxTime: ${maxTime}, currentTime: ${normalizeTimestamp(Date.now(), 1000) / 1000}, fee: ${fee}, baseFee: ${baseFee}`)

                if (maxTime * 1000 < Date.now()) //if the max time is already passed
                    throw new Error(txTimeoutMessage)

                //build transaction
                const tx = await buildTxFn(
                    new Account(account.accountId(), account.sequenceNumber()),
                    fee,
                    maxTime
                )
                logger.debug(`Transaction is built. ${this.__contractInfo}, syncTimestamp: ${syncTimestamp}, submitAttempt: ${submitAttempt}, tx type: ${tx?.type}, maxTime: ${maxTime}, currentTime: ${normalizeTimestamp(Date.now(), 1000) / 1000}, hash: ${tx?.hashHex}`)
                logger.trace(tx?.transaction.toXDR())
                if (tx) { //if tx is null, it means that update is not required on the blockchain, but we need to apply it locally
                    pendingTx = this.__setPendingTransaction(tx, maxTime)
                    this.__trySubmitTransaction()
                    response = await pendingTx.submitPromise


                    const {networkPassphrase} = settingsManager.getBlockchainConnectorSettings()

                    //check if transaction was signed by the current node
                    const resultTx = new Transaction(response.envelopeXdr, networkPassphrase)
                    if (this.contractId
                        && resultTx.signatures.some(s => s.hint().equals(settingsManager.appConfig.keypair.signatureHint())))
                        statisticsManager.incSubmittedTransactions(this.contractId)
                }
                return response
            } catch (e) {
                logger.debug(e.message === txTimeoutMessage ? e.message : e)
                errors.push(e)
            }
        }
        for (const e of errors)
            logger.error(e.message === txTimeoutMessage ? e.message : e)
        throw new Error('Failed to submit transaction. See logs for details.')
    }

    __isTxExpired(timestamp, syncDelay) {
        const syncTimestamp = timestamp + syncDelay
        return getMaxTime(syncTimestamp, maxSubmitAttempts) * 1000 < Date.now()
    }

    __getNextTimestamp(currentTimestamp) {
        throw new Error('Not implemented')
    }

    get __timeframe() {
        throw new Error('Not implemented')
    }

    get __delay() {
        return 0
    }

    get __contractType() {
        return undefined
    }

    get __contractInfo() {
        switch (this.constructor.name) {
            case 'ClusterRunner':
                return 'ClusterRunner'
            case 'OracleRunner':
                return `OracleRunner: ${this.contractId}`
            case 'SubscriptionsRunner':
                return `SubscriptionsRunner: ${this.contractId}`
            case 'PriceRunner':
                return `PriceRunner`
            default:
                return 'unknown'
        }
    }

    /**
     * @returns {ContractConfigBase}
     */
    __getCurrentContract() {
        const {settingsManager} = container
        const contractConfig = settingsManager.getContractConfig(this.contractId)
        if (!contractConfig)
            throw new Error(`Config not found for oracle id: ${this.contractId}`)
        return contractConfig
    }
}

module.exports = RunnerBase