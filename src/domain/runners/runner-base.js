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

class RunnerBase {

    constructor(oracleId) {
        this.oracleId = oracleId
        const timestamp = normalizeTimestamp(Date.now(), this.__timeframe)
        this.isRunning = true
        this.worker(timestamp)
    }

    /**
     * @param {string} txHash - transaction hash
     * @param {DecoratedSignature} signature - transaction signature
     */
    async addSignature(txHash, signature) {
        //if the transaction is not the pending transaction, add the signature to the pending signatures list
        if (this.__pendingTransaction?.hashHex !== txHash) {
            logger.debug(`addSignature: no pending tx. ${this.__pendingTransaction?.hashHex}, ${txHash}`)
            /**@type {timestamp: number, signatures: DecoratedSignature[]} */
            const signaturesData =
                this.__pendingSignatures[txHash] = this.__pendingSignatures[txHash] || {timestamp: Date.now(), signatures: []}
            if (!signaturesData.signatures.find(s => s.hint().equals(signature.hint())))
                signaturesData.signatures.push(signature)
            logger.debug(`addSignature: no pending tx: ${txHash}`)
            return
        }
        this.__pendingTransaction.addSignature(signature)
        await this.__trySubmitTransaction(this)
        logger.debug(`addSignature: added to pending tx: ${txHash}`)
    }

    /**
     * @param {string} pubkey - node public key
     */
    async broadcastSignatureTo(pubkey) {
        if (!this.__pendingTransaction)
            return
        await sendSignature(this.oracleId, pubkey, this.__pendingTransaction)
    }

    stop() {
        this.isRunning = false
        if (this.__workerTimeout)
            clearTimeout(this.__workerTimeout)
    }

    /**
     * @type {PendingTransactionBase}
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
            logger.error(`Error on oracle runner worker. Oracle id: ${this.oracleId}`)
            logger.error(e)
        } finally {
            const nextTimestamp = this.__getNextTimestamp(timestamp)
            let timeout = nextTimestamp - Date.now()
            if (this.oracleId) { //if oracle price runner, add db sync delay
                const dbSyncDelay = (container.settingsManager.appConfig.dbSyncDelay || 15) * 1000
                timeout += dbSyncDelay
            }
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
     */
    __setPendingTransaction(tx) {
        if (this.__pendingTransaction) {
            const {type, timestamp} = this.__pendingTransaction
            logger.error(`Pending transaction wasn't submitted. ContractId: ${this.oracleId}, tx type: ${type}, tx timestamp: ${timestamp}.`)
            this.__clearPendingTransaction()
        }

        const keypair = container.settingsManager.appConfig.keypair

        const signature = keypair.signDecorated(tx.hash)
        tx.addSignature(signature)

        this.__pendingTransaction = tx
        this.__assignPendingSignatures(tx.hashHex, tx)
        broadcastSignature(this.oracleId, tx)
    }

    __clearPendingTransaction() {
        this.__pendingTransaction = null
    }

    /**
     * @returns {Promise<void>}
     */
    async __trySubmitTransaction() {
        const tx = this.__pendingTransaction
        const {settingsManager, statisticsManager} = container
        const currentNodesLength = settingsManager.nodes.size
        if (!tx || !tx.isReadyToSubmit(currentNodesLength)) {
            return
        }
        try {
            this.__clearPendingTransaction() //clear pending transaction to avoid duplicate submission
            const {networkPassphrase, horizonUrls} = this.__getBlockchainConnectorSettings()
            await this.__submitTransaction(networkPassphrase, horizonUrls, tx, tx.getMajoritySignatures(currentNodesLength), this.oracleId)
            if (this.oracleId)
                statisticsManager.incSubmittedTransactions(this.oracleId)
            if (!this.oracleId)
                settingsManager.applyPendingUpdate()
        } catch (e) {
            logger.error(`Error in submit worker. Tx type: ${tx?.type}, tx hash: ${tx?.hashHex}, tx: ${tx.transaction.toXDR()}`)
            logger.error(e)
            //shutdown if the error is not and it's not price update tx
            if (tx.type !== PendingTransactionType.INIT && tx.type !== PendingTransactionType.PRICE_UPDATE)
                container.app.shutdown(13)
        }
        if (this.oracleId)
            statisticsManager.setLastProcessedTimestamp(this.oracleId, tx.timestamp)
        logger.debug(`Transaction is processed ${this.oracleId}. ${tx.getDebugInfo()}`)
    }

    __getBlockchainConnectorSettings() {
        const {settingsManager} = container
        const oraclesNetwork = settingsManager.config.network
        const {networkPassphrase, horizonUrls, dbConnector} = networkConnectionManager.get(oraclesNetwork) || {}
        if (!networkPassphrase)
            throw new Error(`Network passphrase not found: ${oraclesNetwork}`)
        if (!horizonUrls)
            throw new Error(`Horizon urls not found: ${oraclesNetwork}`)
        if (!dbConnector)
            throw new Error(`Blockchain connector not found: ${oraclesNetwork}`)
        return {networkPassphrase, horizonUrls, blockchainConnector: dbConnector}
    }

    /**
     * @param {string} network - network
     * @param {string[]} horizonUrls - horizon urls
     * @param {PendingTransactionBase} pendingTx - transaction
     * @param {DecoratedSignature[]} signatures - signatures
     */
    async __submitTransaction(network, horizonUrls, pendingTx, signatures) {
        let attempts = 10
        const oracleId = this.oracleId
        function processResponse(response) {
            const error = getSubmissionError(response)
            if (error.code === -9 //insufficient fee
                || error.errorName === 'TRY_AGAIN_LATER'
                || error.errorName === 'NOT_FOUND') {
                attempts--
                logger.debug(`Attempt to submit transaction failed. Oracle id: ${oracleId ? oracleId : 'cluster'}. Status: ${error.status}, code: ${error.code ? error.code : 'N/A'}, hash: ${error.hash ? error.hash : pendingTx.hashHex}`)
                return new Promise(resolve => setTimeout(resolve, 2000))
            }
            throw error
        }
        while (attempts > 0) {
            if (!pendingTx)
                throw new Error('tx is required')
            if (!signatures)
                throw new Error('signatures is required')
            if (!network)
                throw new Error('network is required')
            if (!horizonUrls)
                throw new Error('horizonUrls is required')

            const txXdr = pendingTx.transaction.toXDR() //Get the raw XDR for the transaction to avoid modifying the transaction object
            const tx = new Transaction(txXdr, network) //Create a new transaction object from the XDR
            signatures.forEach(signature => tx.addDecoratedSignature(signature))

            const hash = tx.hash().toString('hex')

            const getTransactionFn = async (horizonUrl) => {
                const server = new SorobanRpc.Server(horizonUrl, {allowHttp: true})
                return await server.getTransaction(hash)
            }

            let response = await makeServerRequest(horizonUrls, getTransactionFn)
            if (response.status === 'SUCCESS') {
                response.hash = hash
                return response
            }

            const sendTransactionFn = async (horizonUrl) => {
                const server = new SorobanRpc.Server(horizonUrl, {allowHttp: true})
                return await server.sendTransaction(tx)
            }

            const submitResult = await makeServerRequest(horizonUrls, sendTransactionFn)
            if (submitResult.status !== 'PENDING') {
                await processResponse(response)
                continue
            }

            response = await makeServerRequest(horizonUrls, getTransactionFn)
            let getResultAttempts = 10
            while ((response.status === 'PENDING' || response.status === 'NOT_FOUND') && getResultAttempts > 0) {
                await new Promise(resolve => setTimeout(resolve, 500))
                response = await makeServerRequest(horizonUrls, getTransactionFn)
                getResultAttempts--
            }

            response.hash = hash //Add hash to response to avoid return new object
            if (response.status !== 'SUCCESS') {
                await processResponse(response)
                continue
            }
            return response
        }
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
}

module.exports = RunnerBase