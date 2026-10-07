/*eslint-disable class-methods-use-this */
const {Account, Transaction, xdr} = require('@stellar/stellar-sdk')
const {normalizeTimestamp} = require('@reflector/reflector-shared')
//the submit schedule of every runner, from reflector-shared: node-orchestrator derives the cluster update hash from the
//same module
const {FEE_MULTIPLIER: feeMultiplier, maxSubmitAttempts, getMaxTime} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const MessageTypes = require('../../ws-server/handlers/message-types')
const nodesManager = require('../nodes/nodes-manager')
const {submitTransaction, txTimeoutMessage, withDeadline} = require('../../utils')
const statisticsManager = require('../statistics-manager')
const {runWithContext} = require('../../async-storage')

/**
 * @typedef {import('@reflector/reflector-shared').PendingTransactionBase} PendingTransactionBase
 * @typedef {import('@stellar/stellar-sdk').xdr.DecoratedSignature} DecoratedSignature
 * @typedef {import('@stellar/stellar-sdk').rpc.Api.GetSuccessfulTransactionResponse} SuccessfulTransactionResponse
 * @typedef {import('@reflector/reflector-shared').ContractConfigBase} ContractConfigBase
 */

/**
 * @typedef {Object} LandedTransaction
 * @property {SuccessfulTransactionResponse|null} response - submission result; null when the build returned no transaction
 * @property {PendingTransactionBase|null} tx - the built transaction that landed; null when the build returned none
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
 * @param {number} signersCount - size of the node set captured when the transaction was built
 * @returns {{tx: PendingTransactionBase, signersCount: number, resolve: Function, reject: Function, submitPromise: Promise<any>, iteration: number, status: string}}
 */
function createPendingTransactionObject(tx, maxTime, signersCount) {
    const pendingTxObject = {tx, signersCount}
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

//getMaxTime (reflector-shared) gives attempt 1 firstAttemptTimeout (40 s: worker, build, signature collection, rpc and
//the Stellar lookahead) and attempt 2 the rest of the round, until the next round's sync (__roundLength). The retry pays
//feeMultiplier (8) times the base fee, so it outbids the first attempt decisively
//defence in depth: worker() awaits __workerFn, so a build that never settles would suppress every later tick
const buildTimeout = 15_000
const buildTimeoutMessage = 'Transaction build timed out.'
//a failed build is built again after this pause, about one ledger, for as long as its attempt lasts: attempt 2 is the
//last one, and a dropped connection or a briefly unavailable rpc would otherwise end the round
const buildRetryPause = 5_000
//the simulation answered and refused the transaction - InvalidTimestamp when the other nodes already landed the round.
//oracle-client throws the rpc's simulation error string unchanged, and asking again gets the same answer
const simulationRejectionPattern = /^HostError\b/
//one budget for the reads a worker makes before it builds. They sit outside the build deadline, and makeServerRequest
//retries 3 x N urls with a 300 ms sleep between rounds, so the 15 s per-request deadline still allows ~135 s per call
//on three dead urls - longer than the shortest transaction envelope (60 s from syncTimestamp). Ruling 6
//Sizing: the shortest oracle timeframe is 60 s (OracleConfig: a whole number of minutes), and an oracle worker has
//one timeframe, at least 60 s, from its start to the end of attempt 2. Pre-build reads (20 s), the price-history load
//(20 s, the same budget) and the build (15 s) take at most 20 + 20 + 15 = 55 s of it. With a hung first rpc url the
//node abstains for the first tick rather than failing over within it: every request of that tick pays the 15 s
//per-request deadline on the hung url first, and three pre-build requests (45 s) cannot fit in 20 s. Each rpc helper
//(this node's makeServerRequest, reflector-shared makeRequest, oracle-client makeServerRequest) then remembers the url
//that answered for ten minutes, so later ticks start there and the node signs again while the first url is still hung;
//every ten minutes the configured order is tried again, which can cost one more tick each time.
//These deadlines end the wait; the shared reads and the simulations carry a 15 s per-request deadline of their own
//in reflector-shared and oracle-client.
const preBuildTimeout = 20_000
const preBuildTimeoutMessage = 'Pre-build contract reads timed out.'
const txHashPattern = /^[0-9a-f]{64}$/
//A bucket is opened only by an authenticated cluster peer, and every peer is capped at maxPendingHashesPerPeer, so
//filling this bound takes 256 / 16 = 16 distinct peers each holding a full quota inside the 60 s TTL. A majority is
//floor(n / 2) + 1, so 16 peers are a minority only from 32 nodes upwards: below that no minority can reach the bound,
//and honest traffic cannot either - the same envelope that sizes the per-peer cap puts an honest peer at ~4 live
//buckets. It is therefore a fixed memory bound (runners x 256 buckets), not the flood defence; the per-peer cap is.
//Kept as a constant rather than derived from the live node count, because 16 x nodeCount is exactly the sum of the
//per-peer quotas and would never bind. When the bound is reached the refusal is global, including for the hash this
//runner is about to build, so a cluster of 32 nodes or more should evict the oldest bucket instead.
const maxPendingHashes = 256 //distinct transaction hashes buffered per runner
const maxPendingHashesPerPeer = 16 //2 attempts x 2 ticks inside the 60 s TTL, doubled for clock skew, with room to spare
const runnerStoppedMessage = 'Runner stopped'
//a long wait re-reads the clock this often, so a paused host or a stepped clock delays a tick by at most this much; it
//also keeps every delay far inside the timer range (Node replaces a delay over 2^31 - 1 ms with 1 ms)
const rescheduleStep = 60000
const tickSkippedMessage = 'Tick skipped: its submission deadlines passed before the round started'
const tradesDataNotFoundCode = 'TRADES_DATA_NOT_FOUND' //set by price-manager when no consensus trades data exists

/**
 * A deadline that expired is logged as one line; anything else is logged as a full error object. A build deadline
 * is a timeout and has to read as one, or the retry loop prints the whole error for it.
 * @param {Error} e - error raised by one submit attempt
 * @returns {boolean}
 */
function isExpectedTimeout(e) {
    return e?.message === txTimeoutMessage || e?.message === buildTimeoutMessage
}

/**
 * @param {Error} e - error raised by a build
 * @returns {boolean} true when the simulation refused the transaction, so building it again cannot help
 */
function isSimulationRejection(e) {
    return typeof e?.message === 'string' && simulationRejectionPattern.test(e.message)
}

/**
 * Bounds the contract reads a runner makes before it builds, as one budget for all of them. The rejection is left to
 * RunnerBase.worker, which logs it and schedules the next tick as usual
 * @param {Promise<any>} promise - the reads, already started
 * @param {string} [message] - error message used when the budget is exhausted
 * @returns {Promise<any>}
 */
function withPreBuildDeadline(promise, message = preBuildTimeoutMessage) {
    return withDeadline(promise, preBuildTimeout, message)
}

class RunnerBase {

    constructor(contractId) {
        this.contractId = contractId
    }

    start() {
        const timestamp = normalizeTimestamp(Date.now(), this.__timeframe)
        this.isRunning = true
        //avoid starting before sync time; the timer is stored like every later one, so stop() cancels it too
        this.__scheduleWorker(timestamp)
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
        //abort the transaction in flight so a stopped or removed contract cannot submit afterwards
        if (this.__pendingTransaction) {
            const {reject} = this.__pendingTransaction
            this.__clearPendingTransaction()
            reject(new Error(runnerStoppedMessage))
        }
    }

    /**
     * @type {{tx: PendingTransactionBase, signersCount: number, resolve: Function, reject: Function, submitPromise: Promise<any>, iteration: number, status: string}}
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
     * Set when an attempt in this worker run submitted a footprint-restore transaction instead of the update
     * @type {boolean}
     */
    __isRestoreSubstitution = false

    /**
     * @param {number} timestamp - timestamp
     * @returns {Promise<boolean>} - true if the tx is processed
     */
    __workerFn(timestamp) {
        throw new Error('Not implemented')
    }

    /**
     * @param {number} timestamp - target tick timestamp
     * @returns {number} milliseconds until the worker should run
     */
    __getWorkerTimeout(timestamp) {
        const timeout = timestamp - Date.now() + this.__delay
        if (!Number.isFinite(timeout)) {
            //a non-finite delay reaches setTimeout as 1 ms and re-enters the worker about once per millisecond
            //(as the orchestrator guards its own timers). Fall back to one timeframe, never to 1.
            logger.error({msg: 'Non-finite worker timeout; falling back to one timeframe', ...this.__contractInfo, timestamp, delay: this.__delay})
            return this.__timeframe
        }
        return timeout
    }

    /**
     * Arms the worker for a tick. A wait longer than one step is taken in steps, each re-reading the clock: a host that
     * was paused, or a clock stepped forward, then delays the tick by at most one step, and no delay ever leaves the
     * timer range (a cluster update scheduled weeks ahead would otherwise become a 1 ms timer)
     * @param {number} timestamp - tick to run the worker for
     * @param {boolean} [rearm] - a later step of the same wait, not logged again
     */
    __scheduleWorker(timestamp, rearm = false) {
        if (rearm)
            timestamp = this.__retarget(timestamp)
        const timeout = this.__getWorkerTimeout(timestamp)
        if (!rearm)
            logger.debug({msg: 'Worker timeout', timeout, ...this.__contractInfo})
        if (timeout > rescheduleStep) {
            this.__workerTimeout = setTimeout(() => this.__scheduleWorker(timestamp, true), rescheduleStep)
            return
        }
        this.__workerTimeout = setTimeout(() => this.__runWorker(timestamp), Math.max(1, timeout))
    }

    /**
     * The tick a long wait aims for, re-read at every step of it. A runner whose next tick depends on state that can
     * change while it waits brings the tick forward here
     * @param {number} timestamp - tick the wait was armed for
     * @returns {number}
     */
    __retarget(timestamp) {
        return timestamp
    }

    async worker(timestamp) {
        if (!this.isRunning)
            return
        try {
            logger.info({msg: 'Start worker', timestamp, ...this.__contractInfo})
            this.__payloadMajorityData = createMajorityPromiseData()
            this.__isRestoreSubstitution = false
            const isTxProcessed = await this.__workerFn(timestamp)
            //update last processed timestamp - but a substituted restore transaction is not the update this tick asked for
            if (isTxProcessed && !this.__isRestoreSubstitution && this.contractId)
                statisticsManager.setLastProcessedTimestamp(this.contractId, this.__contractType, timestamp)
        } catch (err) {
            if (err?.message === tickSkippedMessage)
                logger.warn({msg: tickSkippedMessage, ...this.__contractInfo, timestamp})
            else if (err?.code === tradesDataNotFoundCode && process.uptime() * 1000 < 2 * this.__timeframe)
                //a node that just started has not gathered its peers' trades data yet
                logger.warn({msg: 'No trades data yet after the start', ...this.__contractInfo, timestamp, reason: err.message})
            else
                logger.error({err, msg: 'Error in worker', ...this.__contractInfo, timestamp})
        } finally {
            //TODO: improve resolve logic for other runners
            //only subscriptions runner should resolve the promise every run
            this.__payloadMajorityData.resolve(false)
            this.__scheduleWorker(this.__getNextTimestamp(timestamp))
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
     * @returns {{tx: PendingTransactionBase, signersCount: number, resolve: Function, reject: Function, submitPromise: Promise<SuccessfulTransactionResponse>}}
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

        //only the cluster as it stands when the transaction is built may sign it, and the majority threshold is the
        //one that node set implies, not whatever the config says at submit time
        const signers = [...container.settingsManager.nodes.keys()]
        tx.setAllowedSigners(signers)
        //addSignature returns false rather than throwing when the signer is outside the allowed set. If this node has
        //just been removed from the cluster, an unchecked false leaves tx.signatures empty and the very next line -
        //broadcastSignature -> getSignatureMessage -> tx.signatures[0].toXdr('hex') - throws a bare TypeError on every
        //tick, burning both submit attempts and the fee escalation. Fail with a sentence instead.
        if (!tx.addSignature(keypair.signDecorated(tx.hash), publicKey))
            throw new Error('This node is not in the current cluster node set; not signing')

        this.__pendingTransaction = createPendingTransactionObject(tx, maxTime, signers.length)

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
        if (!this.isRunning) //a stopped or removed runner must not submit
            return
        const {settingsManager} = container
        if (!this.__pendingTransaction)
            return
        //the threshold is the one captured when the transaction was built, not the live node count
        const {signersCount} = this.__pendingTransaction
        if (!this.__pendingTransaction.tx.isReadyToSubmit(signersCount))
            return
        this.__payloadMajorityData.resolve(true) //we got the majority, so the payload is the same for the majority of nodes
        const {tx, reject, resolve} = this.__pendingTransaction
        const {networkPassphrase, sorobanRpc} = settingsManager.getBlockchainConnectorSettings()
        try {
            this.__clearPendingTransaction() //clear pending transaction to avoid duplicate submission
            tx.submitted = true
            //sleep for random time from 0 to 1 seconds to avoid simultaneous submissions
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1000)))
            if (!this.isRunning) { //stopped while waiting out the submission jitter
                reject(new Error(runnerStoppedMessage))
                return
            }
            const result = await submitTransaction(
                networkPassphrase,
                sorobanRpc,
                tx,
                tx.getMajoritySignatures(signersCount),
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
     * @returns {Promise<LandedTransaction>} the submission result and the built transaction that landed. A caller that
     * needs anything from the build reads it from this tx: a build abandoned by its deadline keeps running and must not
     * be able to decide anything
     */
    async __buildAndSubmitTransaction(buildTxFn, account, baseFee, timestamp, syncDelay = 0) {
        const errors = []

        const {settingsManager} = container

        const syncTimestamp = timestamp + syncDelay
        const roundLength = this.__roundLength
        //a round that starts after its last deadline - a late wake-up, or a tick a new runner catches up with - cannot
        //land; it is skipped as a whole instead of failing every attempt
        if (this.__isTxExpired(timestamp, syncDelay))
            throw new Error(tickSkippedMessage)

        for (let submitAttempt = 0; submitAttempt < maxSubmitAttempts; submitAttempt++) {
            if (!this.isRunning) { //stopped or removed mid-flight
                logger.debug({msg: 'Runner stopped, abandoning the transaction.', ...this.__contractInfo, syncTimestamp})
                throw new Error(runnerStoppedMessage)
            }
            try {
                //per attempt: a response an earlier attempt left behind must never pair with this attempt's tx (N-4)
                let response = null
                const fee = baseFee * Math.pow(feeMultiplier, submitAttempt)
                const maxTime = getMaxTime(syncTimestamp, submitAttempt, roundLength)
                logger.debug({msg: 'Build transaction.', ...this.__contractInfo, syncTimestamp, submitAttempt, maxTime, currentTime: normalizeTimestamp(Date.now(), 1000) / 1000, fee, baseFee})

                if (maxTime * 1000 < Date.now()) //if the max time is already passed
                    throw new Error(txTimeoutMessage)

                const tx = await this.__buildTransaction(buildTxFn, account, fee, maxTime, {syncTimestamp, submitAttempt})
                //oracle-client substitutes a footprint-restore transaction when the simulation demands one. The flag is
                //non-enumerable and does not survive an xdr rebuild, so it is read here, before anything re-parses the tx.
                const isRestore = !!tx?.transaction?.isRestore
                if (isRestore)
                    logger.warn({msg: 'Simulation demanded a footprint restore; submitting the restore transaction instead of the requested update', ...this.__contractInfo, syncTimestamp, submitAttempt, txType: tx?.type, hash: tx?.hashHex})
                logger.debug({msg: 'Transaction is built.', ...this.__contractInfo, syncTimestamp, submitAttempt, txType: tx?.type, maxTime, currentTime: normalizeTimestamp(Date.now(), 1000) / 1000, hash: tx?.hashHex})
                logger.trace({msg: 'Transaction XDR', tx: tx?.transaction.toXdr()})
                if (tx) { //if tx is null, it means that update is not required on the blockchain, but we need to apply it locally
                    const pendingTx = this.__setPendingTransaction(tx, maxTime)
                    this.__trySubmitTransaction()
                    response = await pendingTx.submitPromise

                    if (isRestore) {
                        //marked only once the restore has landed: a failed restore attempt followed by a retry that
                        //lands the requested update must still count that update
                        this.__isRestoreSubstitution = true
                        logger.debug({msg: 'Restore transaction processed; the requested update is not counted', ...this.__contractInfo, hash: tx?.hashHex})
                    } else {
                        const {networkPassphrase} = settingsManager.getBlockchainConnectorSettings()

                        //check if transaction was signed by the current node
                        const resultTx = new Transaction(response.envelopeXdr, networkPassphrase)
                        if (this.contractId
                            && resultTx.signatures.some(s => s.hint.equals(new xdr.SignatureHint(settingsManager.appConfig.keypair.signatureHint()))))
                            statisticsManager.incSubmittedTransactions(this.contractId, this.__contractType)
                        statisticsManager.setProcessedTx(this.contractId, Buffer.from(resultTx.hash()).toString('hex'))
                    }
                }
                return {response, tx: tx || null}
            } catch (e) {
                logger.debug(isExpectedTimeout(e) ? e.message : e)
                errors.push(e)
            }
        }
        for (const e of errors)
            logger.error(isExpectedTimeout(e) ? e.message : e)
        throw new Error('Failed to submit transaction. See logs for details.')
    }

    /**
     * Builds one attempt's transaction, each build under its own deadline, never longer than what is left of the
     * attempt's envelope. A failed build is built again after buildRetryPause while the attempt lasts, from the same
     * account, fee and maxTime, so it carries the hash the other nodes signed; a simulation rejection is final
     * @param {function} buildTxFn - build function
     * @param {Account} account - account object
     * @param {number} fee - this attempt's fee
     * @param {number} maxTime - this attempt's max time, in seconds
     * @param {{syncTimestamp: number, submitAttempt: number}} round - the round and attempt, for the log
     * @returns {Promise<PendingTransactionBase|null>} the built transaction; rejects with the last build's error once
     * the attempt has no time left for another
     */
    async __buildTransaction(buildTxFn, account, fee, maxTime, round) {
        for (let build = 1; ; build++) {
            try {
                return await withDeadline(
                    buildTxFn(
                        new Account(account.accountId(), account.sequenceNumber()),
                        fee,
                        maxTime
                    ),
                    Math.min(buildTimeout, maxTime * 1000 - Date.now()),
                    buildTimeoutMessage
                )
            } catch (e) {
                const timeLeft = maxTime * 1000 - Date.now()
                if (isSimulationRejection(e) || timeLeft <= buildRetryPause)
                    throw e
                logger.warn({msg: 'Transaction build failed; building it again', ...this.__contractInfo, ...round, build, reason: e?.message, retryIn: buildRetryPause, timeLeft})
            }
            await new Promise(resolve => setTimeout(resolve, buildRetryPause))
            if (!this.isRunning)
                throw new Error(runnerStoppedMessage)
        }
    }

    __isTxExpired(timestamp, syncDelay) {
        const syncTimestamp = timestamp + syncDelay
        return getMaxTime(syncTimestamp, maxSubmitAttempts - 1, this.__roundLength) * 1000 < Date.now()
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

    /**
     * Milliseconds from a round's sync timestamp to the end of its last attempt: by default the next round starts one
     * timeframe later, and attempt 2 runs until then. It bounds every transaction the round signs, so it must be the
     * same on every node: derived from the contract config and chain state, never from the clock
     * @type {number}
     */
    get __roundLength() {
        return this.__timeframe
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
module.exports.runnerStoppedMessage = runnerStoppedMessage
module.exports.tickSkippedMessage = tickSkippedMessage
module.exports.tradesDataNotFoundCode = tradesDataNotFoundCode
module.exports.withPreBuildDeadline = withPreBuildDeadline
