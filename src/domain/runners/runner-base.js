/*eslint-disable class-methods-use-this */
const {Account, Transaction, xdr} = require('@stellar/stellar-sdk')
const {normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const MessageTypes = require('../../ws-server/handlers/message-types')
const nodesManager = require('../nodes/nodes-manager')
const {submitTransaction, txTimeoutMessage} = require('../../utils')
const statisticsManager = require('../statistics-manager')
const {runWithContext} = require('../../async-storage')

/**
 * @typedef {import('@reflector/reflector-shared').PendingTransactionBase} PendingTransactionBase
 * @typedef {import('@stellar/stellar-sdk').xdr.DecoratedSignature} DecoratedSignature
 * @typedef {import('@stellar/stellar-sdk').rpc.Api.GetSuccessfulTransactionResponse} SuccessfulTransactionResponse
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
            signature: tx.signatures[0].toXdr('hex') //first signature always belongs to the current node
        }
    }
}

/**
 * @param {number} syncTimestamp - sync timestamp in milliseconds
 * @param {number} iteration - 1-based iteration (attempt 0 = iteration 1)
 * @returns {number} - max time in seconds
 */
function getMaxTime(syncTimestamp, iteration) {
    //attempt 0 gets firstAttemptTimeout; each retry adds retryAttemptTimeout.
    //decoupling these budgets lets us keep the happy-path window generous
    //(cluster signature collection is the bottleneck) while retries rely on
    //fee escalation rather than long envelopes.
    const budgetMs = firstAttemptTimeout + retryAttemptTimeout * (iteration - 1)
    return (syncTimestamp + budgetMs) / 1000
}

/**
 * @param {string} contractId - oracle id
 * @param {PendingTransactionBase} tx - transaction
 */
async function broadcastSignature(contractId, tx) {
    await nodesManager.broadcast(getSignatureMessage(contractId, tx))
    logger.debug({msg: 'Signature broadcasted.', txType: tx.type, txHash: tx.hashHex})
}

/**
 * @param {string} contractId - oracle id
 * @param {string} pubkey - node public key
 * @param {PendingTransactionBase} tx - transaction
 */
async function sendSignature(contractId, pubkey, tx) {
    await nodesManager.sendTo(pubkey, getSignatureMessage(contractId, tx))
    logger.debug({msg: 'Signature sent.', pubkey, txType: tx.type, txHash: tx.hashHex})
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
            logger.debug({msg: 'Transaction timed out.', txType: tx.type, txHash: tx.hashHex, maxTime, submitted: tx.submitted, currentTime: Math.floor(Date.now() / 1000)})
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
const firstAttemptTimeout = 30_000 //attempt 0 budget (ms) — covers worker + build + signature collection + RPC + Stellar lookahead
const retryAttemptTimeout = 15_000 //per-retry budget (ms) — relies on fee escalation to land
const txHashPattern = /^[0-9a-f]{64}$/
//A bucket is opened only by an authenticated cluster peer, and every peer is capped at maxPendingHashesPerPeer, so
//filling this bound takes 256 / 16 = 16 distinct peers each holding a full quota inside the 60 s TTL. A majority is
//floor(n / 2) + 1, so 16 peers are a minority only from 32 nodes upwards: below that no minority can reach the bound,
//and honest traffic cannot either - the same envelope that sizes the per-peer cap puts an honest peer at ~6 live
//buckets. It is therefore a fixed memory bound (runners x 256 buckets), not the flood defence; the per-peer cap is.
//Kept as a constant rather than derived from the live node count, because 16 x nodeCount is exactly the sum of the
//per-peer quotas and would never bind. When the bound is reached the refusal is global, including for the hash this
//runner is about to build, so a cluster of 32 nodes or more should evict the oldest bucket instead.
const maxPendingHashes = 256 //distinct transaction hashes buffered per runner
const maxPendingHashesPerPeer = 16 //3 attempts x 2 ticks inside the 60 s TTL, doubled for clock skew

class RunnerBase {

    constructor(contractId) {
        this.contractId = contractId
    }

    start() {
        const timestamp = normalizeTimestamp(Date.now(), this.__timeframe)
        this.isRunning = true
        //awoid starting before sync time
        setTimeout(() => this.__runWorker(timestamp), Math.max(1, this.__getWorkerTimeout(timestamp)))
        this.__clearPendingSignatures()
    }

    syncTimeframe = 1000 * 5 //5 seconds

    /**
     * @param {string} txHash - transaction hash, 64 lowercase hex characters
     * @param {DecoratedSignature} signature - transaction signature
     * @param {string} from - node public key of the peer that sent it
     */
    addSignature(txHash, signature, from) {
        if (typeof txHash !== 'string' || !txHashPattern.test(txHash)) {
            //a peer-supplied string is never used as a plain-object key
            logger.debug({msg: 'Signature with a malformed transaction hash ignored.', ...this.__contractInfo, node: from})
            return
        }
        if (this.__pendingTransaction?.tx.hashHex !== txHash) {
            this.__bufferSignature(txHash, signature, from)
            return
        }
        //the shared model verifies the hint and the signature against the sender and counts one signature per signer
        if (!this.__pendingTransaction.tx.addSignature(signature, from)) {
            logger.debug({msg: 'Signature rejected by the pending transaction.', ...this.__contractInfo, node: from, txHash})
            return
        }
        logger.debug({msg: 'Signature added to the pending transaction.', ...this.__contractInfo, node: from, txType: this.__pendingTransaction.tx.type, txHash})
        this.__trySubmitTransaction()
    }

    /**
     * Buffers a signature for a transaction this runner has not built yet. The buffer is bounded per peer and in
     * total, so a peer streaming random hashes cannot grow it.
     * @param {string} txHash - transaction hash, already validated
     * @param {DecoratedSignature} signature - transaction signature
     * @param {string} from - node public key of the peer that sent it
     */
    __bufferSignature(txHash, signature, from) {
        let signaturesData = this.__pendingSignatures.get(txHash)
        if (!signaturesData) {
            if (this.__pendingSignatures.size >= maxPendingHashes) {
                logger.debug({msg: 'Pending signature buffer is full.', ...this.__contractInfo, node: from, txHash})
                return
            }
            const peerHashes = this.__pendingSignaturesByPeer.get(from) || 0
            if (peerHashes >= maxPendingHashesPerPeer) {
                logger.debug({msg: 'Peer reached its pending signature quota.', ...this.__contractInfo, node: from, txHash})
                return
            }
            this.__pendingSignaturesByPeer.set(from, peerHashes + 1)
            signaturesData = {timestamp: Date.now(), owner: from, signatures: new Map()}
            this.__pendingSignatures.set(txHash, signaturesData)
        }
        if (signaturesData.signatures.has(from))
            return
        signaturesData.signatures.set(from, signature)
        logger.debug({msg: 'Signature added to the pending signatures.', ...this.__contractInfo, node: from, txHash})
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
        if (this.__pendingSignaturesTimeout)
            clearTimeout(this.__pendingSignaturesTimeout)
    }

    /**
     * @type {{tx: PendingTransactionBase, resolve: Function, reject: Function, submitPromise: Promise<any>, iteration: number, status: string}}
     */
    __pendingTransaction = null

    /**
     * Out-of-order peer signatures keyed by transaction hash; each bucket holds one signature per peer
     * @type {Map<string, {timestamp: number, owner: string, signatures: Map<string, DecoratedSignature>}>}
     */
    __pendingSignatures = new Map()

    /**
     * Number of buffered hashes each peer has opened, so a bucket can be charged back when it is dropped
     * @type {Map<string, number>}
     */
    __pendingSignaturesByPeer = new Map()

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
            logger.info({msg: 'Start worker', timestamp, ...this.__contractInfo})
            this.__payloadMajorityData = createMajorityPromiseData()
            const isTxProcessed = await this.__workerFn(timestamp)
            //update last processed timestamp
            if (isTxProcessed && this.contractId)
                statisticsManager.setLastProcessedTimestamp(this.contractId, this.__contractType, timestamp)
        } catch (err) {
            logger.error({err, msg: 'Error in worker', ...this.__contractInfo, timestamp})
        } finally {
            //TODO: improve resolve logic for other runners
            //only subscriptions runner should resolve the promise every run
            this.__payloadMajorityData.resolve(false)
            const nextTimestamp = this.__getNextTimestamp(timestamp)
            const timeout = this.__getWorkerTimeout(nextTimestamp)
            logger.debug({msg: 'Worker timeout', timeout, ...this.__contractInfo})
            this.__workerTimeout = setTimeout(() => this.__runWorker(nextTimestamp), Math.max(1, timeout))
        }
    }

    /**
     * @param {string} hash - transaction hash
     * @param {PendingTransactionBase} pendingTx - pending transaction
     */
    __assignPendingSignatures(hash, pendingTx) {
        //add pending signatures if any; each is re-verified against the peer that buffered it
        const signaturesData = this.__pendingSignatures.get(hash)
        if (signaturesData)
            for (const [pubkey, signature] of signaturesData.signatures)
                pendingTx.addSignature(signature, pubkey)
        this.__dropPendingSignatures(hash)
    }

    /**
     * Removes one buffered hash and releases the quota of the peer that opened it
     * @param {string} hash - transaction hash
     */
    __dropPendingSignatures(hash) {
        const signaturesData = this.__pendingSignatures.get(hash)
        if (!signaturesData)
            return
        this.__pendingSignatures.delete(hash)
        const peerHashes = this.__pendingSignaturesByPeer.get(signaturesData.owner) || 0
        if (peerHashes <= 1)
            this.__pendingSignaturesByPeer.delete(signaturesData.owner)
        else
            this.__pendingSignaturesByPeer.set(signaturesData.owner, peerHashes - 1)
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
            logger.warn({msg: 'Pending transaction wasn\'t submitted.', ...this.__contractInfo, txType: type, txTimestamp: timestamp})
            this.__clearPendingTransaction()
            reject(new Error('Pending transaction wasn\'t submitted'))
        }

        const {keypair, publicKey} = container.settingsManager.appConfig

        //only the cluster as it stands when the transaction is built may sign it
        tx.setAllowedSigners([...container.settingsManager.nodes.keys()])
        //addSignature returns false rather than throwing when the signer is outside the allowed set. If this node has
        //just been removed from the cluster, an unchecked false leaves tx.signatures empty and the very next line -
        //broadcastSignature -> getSignatureMessage -> tx.signatures[0].toXdr('hex') - throws a bare TypeError on every
        //tick, burning all three submit attempts and the fee escalation. Fail with a sentence instead.
        if (!tx.addSignature(keypair.signDecorated(tx.hash), publicKey))
            throw new Error('This node is not in the current cluster node set; not signing')

        this.__pendingTransaction = createPendingTransactionObject(tx, maxTime)

        this.__assignPendingSignatures(tx.hashHex, tx)
        broadcastSignature(this.contractId, tx)
        return this.__pendingTransaction
    }

    __clearPendingTransaction() {
        logger.debug({msg: 'Clear pending transaction.', ...this.__contractInfo, txType: this.__pendingTransaction?.tx.type, txHash: this.__pendingTransaction?.tx.hashHex})
        this.__pendingTransaction = null
    }

    __clearPendingSignatures() {
        try {
            for (const [hash, signaturesData] of [...this.__pendingSignatures])
                if (Date.now() - signaturesData.timestamp > 60000) //1 minute
                    this.__dropPendingSignatures(hash)
        } catch (err) {
            logger.error({err}, 'Error in __clearPendingSignatures')
        } finally {
            this.__pendingSignaturesTimeout = setTimeout(() => this.__clearPendingSignatures(), 60000) //1 minute
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
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1000)))
            const result = await submitTransaction(
                networkPassphrase,
                sorobanRpc,
                tx,
                tx.getMajoritySignatures(currentNodesLength),
                this.__contractInfo
            )
            resolve(result)
            logger.debug({msg: 'Transaction is processed.', ...this.__contractInfo, txDebugInfo: tx.getDebugInfo()})
        } catch (e) {
            const error = new Error(`Error in submit worker. Tx type: ${tx?.type}, tx hash: ${tx?.hashHex}, tx fee: ${tx?.transaction.fee}, tx: ${tx.transaction.toXdr()}`)
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
                const fee = baseFee * Math.pow(8, submitAttempt) //fee escalates 8x per retry so retries can outbid the prior attempt decisively
                const maxTime = getMaxTime(syncTimestamp, submitAttempt + 1)
                logger.debug({msg: 'Build transaction.', ...this.__contractInfo, syncTimestamp, submitAttempt, maxTime, currentTime: normalizeTimestamp(Date.now(), 1000) / 1000, fee, baseFee})

                if (maxTime * 1000 < Date.now()) //if the max time is already passed
                    throw new Error(txTimeoutMessage)

                //build transaction
                const tx = await buildTxFn(
                    new Account(account.accountId(), account.sequenceNumber()),
                    fee,
                    maxTime
                )
                logger.debug({msg: 'Transaction is built.', ...this.__contractInfo, syncTimestamp, submitAttempt, txType: tx?.type, maxTime, currentTime: normalizeTimestamp(Date.now(), 1000) / 1000, hash: tx?.hashHex})
                logger.trace({msg: 'Transaction XDR', tx: tx?.transaction.toXdr()})
                if (tx) { //if tx is null, it means that update is not required on the blockchain, but we need to apply it locally
                    pendingTx = this.__setPendingTransaction(tx, maxTime)
                    this.__trySubmitTransaction()
                    response = await pendingTx.submitPromise


                    const {networkPassphrase} = settingsManager.getBlockchainConnectorSettings()

                    //check if transaction was signed by the current node
                    const resultTx = new Transaction(response.envelopeXdr, networkPassphrase)
                    if (this.contractId
                        && resultTx.signatures.some(s => s.hint.equals(new xdr.SignatureHint(settingsManager.appConfig.keypair.signatureHint()))))
                        statisticsManager.incSubmittedTransactions(this.contractId, this.__contractType)
                    statisticsManager.setProcessedTx(this.contractId, Buffer.from(resultTx.hash()).toString('hex'))
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
        return {runner: this.constructor.name, contract: this.contractId, type: this.__contractType}
    }

    /**
     * @returns {ContractConfigBase}
     */
    __getCurrentContract() {
        const {settingsManager} = container
        const contractConfig = settingsManager.getContractConfig(this.contractId)
        if (!contractConfig)
            throw new Error(`Config not found.`)
        return contractConfig
    }

    __runWorker(timestamp) {
        return runWithContext(async () => await this.worker(timestamp))
    }
}

module.exports = RunnerBase