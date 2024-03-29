/*eslint-disable class-methods-use-this */
const {Account, Transaction, SorobanRpc} = require('@stellar/stellar-sdk')
const {PendingTransactionType, normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const MessageTypes = require('../../ws-server/handlers/message-types')
const networkConnectionManager = require('../data-sources-manager')
const nodesManager = require('../nodes/nodes-manager')

/**
 * @typedef {import('@reflector/reflector-shared').PendingTransactionBase} PendingTransactionBase
 * @typedef {import('@stellar/stellar-sdk').xdr.DecoratedSignature} DecoratedSignature
 * @typedef {import('@stellar/stellar-sdk').SorobanRpc.Api.SendTransactionResponse} SendTransactionResponse
 * @typedef {import('@stellar/stellar-sdk').SorobanRpc.Api.GetFailedTransactionResponse} GetFailedTransactionResponse
 */

/**
 * @param {string} oracleId - oracle id
 * @param {PendingTransactionBase} tx - transaction
 * @returns {any}
 */
function getSignatureMessage(oracleId, tx) {
    return {
        type: MessageTypes.SIGNATURE,
        data: {
            oracleId,
            hash: tx.hashHex,
            signature: tx.signatures[0].toXDR('hex') //first signature always belongs to the current node
        }
    }
}

/**
 * @param {string} oracleId - oracle id
 * @param {PendingTransactionBase} tx - transaction
 */
async function broadcastSignature(oracleId, tx) {
    await nodesManager.broadcast(getSignatureMessage(oracleId, tx))
    logger.debug(`Signature broadcasted. Contract id: ${oracleId}, tx type: ${tx.type}, tx hash: ${tx.hashHex}`)
}

/**
 * @param {string} oracleId - oracle id
 * @param {string} pubkey - node public key
 * @param {PendingTransactionBase} tx - transaction
 */
async function sendSignature(oracleId, pubkey, tx) {
    await nodesManager.sendTo(pubkey, getSignatureMessage(oracleId, tx))
    logger.debug(`Signature sent to ${pubkey}. Contract id: ${oracleId}, tx type: ${tx.type}, tx hash: ${tx.hashHex}`)
}

/**
 * @param {SendTransactionResponse|GetFailedTransactionResponse} submitResult - transaction submit result
 * @returns {Error}
 */
function getSubmissionError(submitResult) {
    const resultXdr = (submitResult.resultXdr ?? submitResult.errorResult)
    const {name: errorName, value: code} = resultXdr?.result()?.switch() ?? {}
    const error = new Error(`Transaction submit failed: ${submitResult.status}. Error name: ${errorName}, code: ${code}`)
    error.status = submitResult.status
    error.errorResultXdr = resultXdr?.toXDR('base64') ?? null
    error.hash = submitResult.hash
    error.meta = submitResult.resultMetaXdr?.toXDR('base64') ?? null
    error.tx = submitResult.envelopeXdr?.toXDR('base64') ?? null
    error.code = code
    error.errorName = errorName ?? submitResult.status
    return error
}

async function makeServerRequest(urls, requestFn) {
    const errors = []
    for (const url of urls) {
        try {
            return await requestFn(url)
        } catch (err) {
            logger.debug(`Request to ${url} failed. Error: ${err.message}`)
            errors.push(err)
        }
    }
    for (const err of errors)
        logger.error(err)
    throw new Error('Failed to make request. See logs for details.')
}

const txTimeoutMessage = 'Tx timed out.'

/**
 * @param {PendingTransactionBase} tx - transaction
 * @param {number} maxTime - max time in seconds
 * @returns {{tx: PendingTransactionBase, resolve: Function, reject: Function, submitPromise: Promise<any>, iteration: number, status: string}}
 */
function createPendingTransactionObject(tx, maxTime) {
    const pendingTxObject = {tx}
    pendingTxObject.submitPromise = new Promise((resolve, reject) => {
        let isSettled = false

        const timeout = (maxTime * 1000) - Date.now() + 1000 //Add 1 second to the max time
        const timeoutId = setTimeout(() => {
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

class RunnerBase {

    constructor(oracleId) {
        this.oracleId = oracleId
        const timestamp = normalizeTimestamp(Date.now(), this.__timeframe)
        this.isRunning = true
        this.worker(timestamp)
        this.__clearPendingSignatures()
    }

    syncTimeframe = 1000 * 5 //5 seconds

    /**
     * @param {string} txHash - transaction hash
     * @param {DecoratedSignature} signature - transaction signature
     */
    addSignature(txHash, signature) {
        //if the transaction is not the pending transaction, add the signature to the pending signatures list
        if (this.__pendingTransaction?.tx.hashHex !== txHash) {
            /**@type {timestamp: number, signatures: DecoratedSignature[]} */
            const signaturesData =
                this.__pendingSignatures[txHash] = this.__pendingSignatures[txHash] || {timestamp: Date.now(), signatures: []}
            if (!signaturesData.signatures.find(s => s.hint().equals(signature.hint())))
                signaturesData.signatures.push(signature)
            logger.trace(`Signature added to the pending signatures. Oracle id: ${this.oracleId}, tx hash: ${txHash}`)
            return
        }
        this.__pendingTransaction.tx.addSignature(signature)
        logger.trace(`Signature added to the pending transaction. Oracle id: ${this.oracleId}, tx type: ${this.__pendingTransaction.tx.type}, tx hash: ${this.__pendingTransaction.tx.hashHex}`)
        this.__trySubmitTransaction()
    }

    /**
     * @param {string} pubkey - node public key
     */
    async broadcastSignatureTo(pubkey) {
        if (!this.__pendingTransaction)
            return
        await sendSignature(this.oracleId, pubkey, this.__pendingTransaction.tx)
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
     * @returns {Promise}
     */
    __workerFn(timestamp) {
        throw new Error('Not implemented')
    }

    async worker(timestamp) {
        if (!this.isRunning)
            return
        try {
            await this.__workerFn(timestamp)
        } catch (e) {
            logger.error(`Error in worker. Oracle id: ${this.oracleId}, timestamp: ${timestamp}, error: ${e.message}`)
            logger.error(e)
        } finally {
            const nextTimestamp = this.__getNextTimestamp(timestamp)
            let timeout = nextTimestamp - Date.now()
            if (this.oracleId)
                timeout += this.__dbSyncDelay
            logger.trace(`Worker timeout: ${timeout}, oracle id: ${this.oracleId}`)
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
     * @returns {{tx: PendingTransactionBase, resolve: Function, reject: Function, submitPromise: Promise<any>}}
     */
    __setPendingTransaction(tx, maxTime) {
        if (this.__pendingTransaction) {
            const {type, timestamp} = this.__pendingTransaction.tx
            this.__pendingTransaction.reject(new Error('Pending transaction wasn\'t submitted'))
            logger.error(`Pending transaction wasn't submitted. ContractId: ${this.oracleId}, tx type: ${type}, tx timestamp: ${timestamp}.`)
            this.__clearPendingTransaction()
        }

        const keypair = container.settingsManager.appConfig.keypair

        const signature = keypair.signDecorated(tx.hash)
        tx.addSignature(signature)


        this.__pendingTransaction = createPendingTransactionObject(tx, maxTime)

        this.__assignPendingSignatures(tx.hashHex, tx)
        broadcastSignature(this.oracleId, tx)
        return this.__pendingTransaction
    }

    __clearPendingTransaction() {
        logger.debug(`Clear pending transaction. Oracle id: ${this.oracleId}. Tx type: ${this.__pendingTransaction?.tx.type}, tx hash: ${this.__pendingTransaction?.tx.hashHex}`)
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
        } catch (e) {
            logger.error('Error in clearPendingTransaction')
            logger.error(e)
        } finally {
            setTimeout(() => this.__clearPendingTransaction(), 60000) //1 minute
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async __trySubmitTransaction() {
        const {settingsManager, statisticsManager} = container
        const currentNodesLength = settingsManager.nodes.size
        if (!this.__pendingTransaction || !this.__pendingTransaction.tx.isReadyToSubmit(currentNodesLength))
            return
        const {tx, reject, resolve} = this.__pendingTransaction
        try {
            this.__clearPendingTransaction() //clear pending transaction to avoid duplicate submission
            const {networkPassphrase, sorobanRpc} = this.__getBlockchainConnectorSettings()
            tx.submitted = true
            await this.__submitTransaction(networkPassphrase, sorobanRpc, tx, tx.getMajoritySignatures(currentNodesLength))
            if (this.oracleId)
                statisticsManager.setLastProcessedTimestamp(this.oracleId, tx.timestamp)
            resolve()
            logger.debug(`Transaction is processed ${this.oracleId}. ${tx.getDebugInfo()}`)
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
     * @param {number} syncTimestamp - sync timestamp
     */
    async __buildAndSubmitTransaction(buildTxFn, account, baseFee, syncTimestamp) {
        const errors = []
        const {statisticsManager, settingsManager} = container
        let pendingTx = null
        for (let i = 0; i < 4; i++) {
            try {
                const fee = baseFee * Math.pow(4, i) //increase fee by 4 times on each iteration
                const maxTime = this.__getMaxTime(syncTimestamp, i + 1)
                logger.trace(`Build transaction. Oracle id: ${this.oracleId}, iteration: ${i}, maxTime: ${maxTime}, fee: ${fee}, baseFee: ${baseFee}, syncTimestamp: ${syncTimestamp}`)
                if (maxTime * 1000 < Date.now())
                    throw new Error(txTimeoutMessage)
                const tx = await buildTxFn(
                    new Account(account.accountId(), account.sequenceNumber()),
                    fee,
                    maxTime
                )
                if (tx) { //if tx is null, it means that update is not required on the blockchain, but we need to apply it locally
                    pendingTx = this.__setPendingTransaction(tx, maxTime)
                    this.__trySubmitTransaction()
                    await pendingTx.submitPromise
                }
                if (this.oracleId)
                    statisticsManager.incSubmittedTransactions(this.oracleId)
                else
                    settingsManager.applyPendingUpdate()
                return
            } catch (e) {
                errors.push(e)
            }
        }
        for (const e of errors)
            logger.error(e.message === txTimeoutMessage ? e.message : e)
        //shutdown if the error and it's init or not price update tx
        if (![PendingTransactionType.INIT, PendingTransactionType.PRICE_UPDATE].includes(pendingTx?.tx.type))
            container.app.shutdown(13)
        throw new Error('Failed to submit transaction. See logs for details.')
    }

    __getBlockchainConnectorSettings() {
        const {settingsManager} = container
        const oraclesNetwork = settingsManager.config.network
        const {networkPassphrase, sorobanRpc, dbConnector} = networkConnectionManager.get(oraclesNetwork) || {}
        if (!networkPassphrase)
            throw new Error(`Network passphrase not found: ${oraclesNetwork}`)
        if (!sorobanRpc)
            throw new Error(`Soroban rpc urls not found: ${oraclesNetwork}`)
        if (!dbConnector)
            throw new Error(`Blockchain connector not found: ${oraclesNetwork}`)
        return {networkPassphrase, sorobanRpc, blockchainConnector: dbConnector}
    }

    /**
     * @param {string} network - network
     * @param {string[]} sorobanRpc - soroban rpc urls
     * @param {PendingTransactionBase} pendingTx - transaction
     * @param {DecoratedSignature[]} signatures - signatures
     */
    async __submitTransaction(network, sorobanRpc, pendingTx, signatures) {
        let attempts = 10
        const oracleId = this.oracleId
        const hash = pendingTx.hashHex
        function processResponse(response) {
            const error = getSubmissionError(response)
            if (error.errorName === 'TRY_AGAIN_LATER' || error.errorName === 'NOT_FOUND') {
                attempts--
                return new Promise(resolve => setTimeout(resolve, 2000))
            }
            throw error
        }

        const maxTime = Number(pendingTx.transaction.timeBounds.maxTime)
        const currentTimeInSeconds = normalizeTimestamp(Date.now(), 1000) / 1000

        logger.trace(`Account: ${pendingTx.transaction.source}, sequence: ${pendingTx.transaction.sequence}, fee: ${pendingTx.transaction.fee}, maxTime: ${maxTime}, currentTime: ${currentTimeInSeconds}, transaction: ${hash}`)

        const ensureIsNotTimedOut = () => {
            if (pendingTx.isTimedOut)
                throw new Error(txTimeoutMessage)
        }

        while (attempts > 0) {
            ensureIsNotTimedOut()
            const txXdr = pendingTx.transaction.toXDR() //Get the raw XDR for the transaction to avoid modifying the transaction object
            const tx = new Transaction(txXdr, network) //Create a new transaction object from the XDR

            signatures.forEach(signature => tx.addDecoratedSignature(signature))

            const getTransactionFn = async (sorobanRpcUrl) => {
                const server = new SorobanRpc.Server(sorobanRpcUrl, {allowHttp: true})
                return await server.getTransaction(hash)
            }

            let response = await makeServerRequest(sorobanRpc, getTransactionFn)
            if (response.status === 'SUCCESS') {
                logger.trace(`Transaction is already submitted. Oracle id: ${oracleId ? oracleId : 'cluster'}. Tx type: ${pendingTx.type}, hash: ${hash}`)
                response.hash = hash
                return response
            }

            const sendTransactionFn = async (sorobanRpcUrl) => {
                const server = new SorobanRpc.Server(sorobanRpcUrl, {allowHttp: true})
                return await server.sendTransaction(tx)
            }

            ensureIsNotTimedOut()
            const submitResult = await makeServerRequest(sorobanRpc, sendTransactionFn)
            if (!['PENDING', 'DUPLICATE'].includes(submitResult.status)) {
                logger.trace(`Transaction is not pending. Oracle id: ${oracleId ? oracleId : 'cluster'}. Tx type: ${pendingTx.type}, hash: ${hash}, status: ${submitResult.status}`)
                await processResponse(submitResult)
                continue
            }
            response = await makeServerRequest(sorobanRpc, getTransactionFn)
            let getResultAttempts = 10
            while ((response.status === 'PENDING' || response.status === 'NOT_FOUND') && getResultAttempts > 0) {
                await new Promise(resolve => setTimeout(resolve, 500))
                response = await makeServerRequest(sorobanRpc, getTransactionFn)
                getResultAttempts--
                logger.trace(`Attempt to get transaction result. Oracle id: ${oracleId ? oracleId : 'cluster'}. Tx type: ${pendingTx.type}, hash: ${hash}, status: ${response.status}, attempts left: ${getResultAttempts}`)
            }

            response.hash = hash //Add hash to response to avoid return new object
            if (response.status !== 'SUCCESS') {
                await processResponse(response)
                logger.trace(`Transaction is not successful. Oracle id: ${oracleId ? oracleId : 'cluster'}. Tx type: ${pendingTx.type}, hash: ${hash}, status: ${response.status}, attempts left: ${attempts}`)
                continue
            }
            return response
        }
        throw new Error(`Failed to submit transaction. Oracle id: ${oracleId ? oracleId : 'cluster'}. Tx type: ${pendingTx.type}, hash: ${hash}`)
    }

    /**
     * @param {number} syncTimestamp - sync timestamp in milliseconds
     * @param {number} iteration - iteration
     * @returns {number} - max time in seconds
     */
    __getMaxTime(syncTimestamp, iteration) {
        const maxTime = syncTimestamp + (15000 * iteration)
        return maxTime / 1000 //convert to seconds
    }

    /**
     * @param {string} account - account address
     * @param {BigInt} sequence - account sequence
     * @returns {Account}
     */
    __getAccount(account, sequence) {
        return new Account(account, sequence.toString())
    }

    __getNextTimestamp(currentTimestamp) {
        throw new Error('Not implemented')
    }

    get __timeframe() {
        throw new Error('Not implemented')
    }

    get __dbSyncDelay() {
        return 0
    }
}

module.exports = RunnerBase