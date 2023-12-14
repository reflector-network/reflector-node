const {Account, Transaction, SorobanRpc} = require('stellar-sdk')
const {PendingTransactionType, normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const MessageTypes = require('../message-types')
const networkConnectionManager = require('../data-sources-manager')
const nodesManager = require('../nodes/nodes-manager')

/**
 * @typedef {import('@reflector/reflector-shared').PendingTransactionBase} PendingTransactionBase
 * @typedef {import('stellar-sdk').xdr.DecoratedSignature} DecoratedSignature
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

const __pendingSignatures = {}

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
            /**@type {timestamp: number, signatures: DecoratedSignature[]} */
            const signaturesData =
                __pendingSignatures[txHash] = __pendingSignatures[txHash] || {timestamp: Date.now(), signatures: []}
            if (!signaturesData.signatures.find(s => s.hint().equals(signature.hint())))
                signaturesData.signatures.push(signature)
            logger.debug(`addSignature: no pending tx: ${txHash}`)
            return
        }
        this.__pendingTransaction.addSignature(signature)
        await this.trySubmitTransaction(this)
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
     * @returns {Promise<{nextTimestamp: number, timeout: number>}>} - next timestamp and worker timeout
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

            const nextTimestamp = timestamp + this.__timeframe
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
            this.clearPendingTransaction()
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
            const {networkPassphrase, horizonUrl} = networkConnectionManager.get(settingsManager.config.network) || {}
            if (!networkPassphrase)
                throw new Error(`Network passphrase not found: ${settingsManager.config.network}`)
            if (!horizonUrl)
                throw new Error(`Horizon url not found: ${settingsManager.config.network}`)
            await this.__submitTransaction(networkPassphrase, horizonUrl, tx, tx.getMajoritySignatures(currentNodesLength))
            statisticsManager.incSubmittedTransactions(this.oracleId)
        } catch (e) {
            if (e.message !== 'Transaction submit failed: DUPLICATE') {
                logger.error(`Error in submit worker. Tx type: ${tx?.type}, tx hash: ${tx?.hashHex}, tx: ${tx.transaction.toXDR()}`)
                logger.error(e)
                //shutdown if the error is not and it's not price update tx
                if (tx.type !== PendingTransactionType.INIT && tx.type !== PendingTransactionType.PRICE_UPDATE)
                    container.app.shutdown(13)
            }
        }
        statisticsManager.setLastProcessedTimestamp(this.oracleId, tx.timestamp)
        logger.debug(`Transaction is processed. ${tx.getDebugInfo()}`)
    }

    __getBlockchainConnectorSettings() {
        const {settingsManager} = container
        const oraclesNetwork = settingsManager.config.network
        const {networkPassphrase, horizonUrl, dbConnector} = networkConnectionManager.get(oraclesNetwork) || {}
        if (!networkPassphrase)
            throw new Error(`Network passphrase not found: ${oraclesNetwork}`)
        if (!horizonUrl)
            throw new Error(`Horizon url not found: ${oraclesNetwork}`)
        if (!dbConnector)
            throw new Error(`Blockchain connector not found: ${oraclesNetwork}`)
        return {networkPassphrase, horizonUrl, blockchainConnector: dbConnector}
    }

    /**
     * @param {string} network - network
     * @param {string} horizonUrl - horizon url
     * @param {PendingTransactionBase} pendingTx - transaction
     * @param {DecoratedSignature[]} signatures - signatures
     */
    async __submitTransaction(network, horizonUrl, pendingTx, signatures) {
        if (!pendingTx)
            throw new Error('tx is required')
        if (!signatures)
            throw new Error('signatures is required')
        if (!network)
            throw new Error('network is required')
        if (!horizonUrl)
            throw new Error('horizonUrl is required')

        const server = new SorobanRpc.Server(horizonUrl, {allowHttp: true})

        const txXdr = pendingTx.transaction.toXDR() //Get the raw XDR for the transaction to avoid modifying the transaction object
        const tx = new Transaction(txXdr, network) //Create a new transaction object from the XDR
        signatures.forEach(signature => tx.addDecoratedSignature(signature))

        const hash = tx.hash().toString('hex')

        let response = await server.getTransaction(hash)
        if (response.status === 'SUCCESS') {
            response.hash = hash
            return response
        }

        const submitResult = await server.sendTransaction(tx)
        if (submitResult.status !== 'PENDING') {
            const error = new Error(`Transaction submit failed: ${submitResult.status}`)
            error.status = submitResult.status
            error.errorResultXdr = submitResult.errorResultXdr
            error.hash = submitResult.hash
            throw error
        }

        response = await server.getTransaction(hash)
        let attemptsLeft = 10
        while ((response.status === 'PENDING' || response.status === 'NOT_FOUND') && attemptsLeft > 0) {
            await new Promise(resolve => setTimeout(resolve, 500))
            response = await server.getTransaction(hash)
            attemptsLeft--
        }

        response.hash = hash //Add hash to response to avoid return new object
        if (response.status === 'FAILED') {
            const error = new Error(`Transaction submit failed, result: ${response.status}`)
            error.status = response.status
            error.hash = response.hash
            error.envelopeXdr = response.envelopeXdr
            error.resultXdr = response.resultXdr
            error.resultMetaXdr = response.resultMetaXdr
        }
        return response
    }

    /**
     * @param {string} account - account address
     * @param {BigInt} sequence - account sequence
     * @returns {Account}
     */
    __getAccount(account, sequence) {
        return new Account(account, sequence.toString())
    }

    get __timeframe() {
        throw new Error('Not implemented')
    }
}

module.exports = RunnerBase