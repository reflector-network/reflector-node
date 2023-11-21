const OracleClient = require('@reflector-network/oracle-client')
const {aggregateTrades, retrieveAccountProps} = require('@reflector/reflector-db-connector')
const {Account} = require('soroban-client')
const PriceUpdatePendingTransaction = require('../models/blockchain/transactions/price-update-pending-transaction')
const InitPendingTransaction = require('../models/blockchain/transactions/init-pending-transaction')
const logger = require('../logger')
const PendingTransactionType = require('../models/blockchain/transactions/pending-transaction-type')
const container = require('./container')
const MessageTypes = require('./message-types')
const {buildUpdateTransaction} = require('./transaction-builder')


/**
 * @typedef {import('./nodes-manager')} NodesManager
 * @typedef {import('../models/blockchain/transactions/pending-transaction-base')} PendingTransactionBase
 */
/**
 * @param {PendingTransactionBase} tx - transaction
 * @returns {any}
 */
function __getSignatureMessage(tx) {
    return {
        type: MessageTypes.SIGNATURE,
        data: {
            hash: tx.hashHex,
            signature: tx.signatures[0].toXDR('hex') //first signature always belongs to the current node
        }
    }
}

/**
 * @param {PendingTransactionBase} tx - transaction
 */
async function __broadcastSignature(tx) {
    const {nodesManager} = container
    await nodesManager.broadcast(__getSignatureMessage(tx))
    logger.debug(`Signature broadcasted. Tx type: ${tx.type}, tx hash: ${tx.hashHex}`)
}

/**
 * @param {string} pubkey - node public key
 * @param {PendingTransactionBase} tx - transaction
 */
async function __sendSignature(pubkey, tx) {
    const {nodesManager} = container
    await nodesManager.sendTo(pubkey, __getSignatureMessage(tx))
    logger.debug(`Signature sent to ${pubkey}. Tx type: ${tx.type}, tx hash: ${tx.hashHex}`)
}

/**
 * @param {number} timestamp - timestamp
 * @param {number} timeframe - timeframe
 * @returns {number}
 */
function normalizeTimestamp(timestamp, timeframe) {
    return Math.floor(timestamp / timeframe) * timeframe
}

class TransactionsManager {

    isRunning = false

    async start() {
        try {
            if (this.isRunning)
                return
            this.isRunning = true
            this.__oracleClient = new OracleClient(this.__reflector.network, this.__reflector.horizon, this.__reflector.oracleId)
            await this.__systemUpdateWorker()
            const currentTimestamp = normalizeTimestamp(Date.now(), this.__reflector.timeframe)
            const priceUpdateWorkerStartDelay = this.__pendingTransaction //if pending tx is defined, it's system update
                ? (currentTimestamp + (this.__reflector.timeframe) - Date.now()) //if pending tx is not submitted, give it half of the timeframe to be submitted
                : 0
            this.__priceUpdateWorkerTimeout = setTimeout(() => this.__priceUpdateWorker(currentTimestamp), priceUpdateWorkerStartDelay)
            this.__pendingSignaturesCleaner()
            this.__submitWorker()
        } catch (e) {
            logger.error(e)
            container.app.shutdown()
        }
    }

    stop() {
        this.isRunning = false
        this.__oracleClient = null
        this.__clearPendingTransaction()
        this.__pendingSignatures = {}
        this.__priceUpdateWorkerTimeout && clearTimeout(this.__priceUpdateWorkerTimeout)
        this.__pendingSignaturesCleanerTimeout && clearTimeout(this.__pendingSignaturesCleanerTimeout)
        this.__systemUpdateWorkerTimeout && clearTimeout(this.__systemUpdateWorkerTimeout)
    }

    async broadcastSignatureTo(pubkey) {
        if (!this.__pendingTransaction)
            return
        await __sendSignature(pubkey, this.__pendingTransaction)
    }

    /**
     * @param {string} txHash - transaction hash
     * @param {xdr.DecoratedSignature} signature - transaction signature
     */
    addSignature(txHash, signature) {
        //if the transaction is not the pending transaction, add the signature to the pending signatures list
        if (this.__pendingTransaction?.hashHex !== txHash) {
            /**@type {timestamp: number, signatures: xdr.DecoratedSignature[]} */
            const signaturesData =
                this.__pendingSignatures[txHash] = this.__pendingSignatures[txHash] || {timestamp: Date.now(), signatures: []}
            if (!signaturesData.signatures.find(s => s.hint().equals(signature.hint())))
                signaturesData.signatures.push(signature)
            logger.debug(`addSignature: no pending tx: ${txHash}`)
            return
        }
        this.__pendingTransaction.addSignature(signature)
        logger.debug(`addSignature: added to pending tx: ${txHash}`)
    }

    /**
     * @type {PendingTransactionBase}
     */
    __pendingTransaction = null

    /**
     * @type {[string, string[]]}
     */
    __pendingSignatures = {}

    get __reflector() {
        return container.settingsManager.contractSettings
    }

    get __keypair() {
        return container.settingsManager.config.keypair
    }

    get __txOptions() {
        return {fee: this.__reflector.fee, minAccountSequence: '0'}
    }

    get __dbSyncDelay() {
        return container.settingsManager.config.dbSyncDelay * 1000
    }

    __checkIfInitialized() {
        if (!this.isRunning)
            throw new Error('TransactionsManager is not initialized')
    }

    __pendingSignaturesCleaner() {
        if (!this.isRunning)
            return
        try {
            const keys = Object.keys(this.__pendingSignatures)
            for (const key of keys) {
                const signaturesData = this.__pendingSignatures[key]
                if (Date.now() - signaturesData.timestamp > 1000 * 60)
                    delete this.__pendingSignatures[key]
            }
        } catch (e) {
            logger.error(e)
        } finally {
            this.__pendingSignaturesCleanerTimeout = setTimeout(() => this.__pendingSignaturesCleaner(), 1000 * 60)
        }
    }

    async __systemUpdateWorker() {
        if (!this.isRunning)
            return
        try {
            let tx = null
            const {contractSettings} = container.settingsManager
            const aggregatedTrades = await this.__getAggregatedTrades(0)
            if (!aggregatedTrades.isContractInitialized) { //build init transaction
                if (this.__pendingTransaction?.type === PendingTransactionType.INIT)
                    return //init transaction is already pending

                tx = new InitPendingTransaction(
                    await this.__oracleClient.config(
                        await this.__getAccount(),
                        contractSettings,
                        this.__txOptions
                    ),
                    1,
                    contractSettings)
            } else {
                const {pendingUpdate} = contractSettings
                const {timestamp: txTs, type: txType} = this.__pendingTransaction || {}
                if (!(pendingUpdate
                    && pendingUpdate.timestamp <= Date.now()
                    && txTs !== pendingUpdate.timestamp
                    && txType !== pendingUpdate.type)
                )
                    return //current pending tx is pending update

                tx = await buildUpdateTransaction(
                    pendingUpdate,
                    await this.__getAccount(),
                    this.__txOptions,
                    this.__oracleClient,
                    container.settingsManager)
                if (tx === null) {
                    logger.debug('No pending transaction is built')
                    //if tx is null, it means that update is not required on the blockchain, but we need to apply it locally
                    //for example, node url is changed, but it's not required to update it on the blockchain
                    container.settingsManager.applyUpdate()
                    return
                }
            }
            this.__setPendingTransaction(tx)
        } catch (e) {
            logger.error('Error in system update worker')
            logger.error(e)
        } finally {
            this.__systemUpdateWorkerTimeout = setTimeout(() => this.__systemUpdateWorker(), 10000)
        }
    }

    /**
     * @param {number} timestamp - timestamp
     * @returns {Promise<{prices: BigInt[], admin: string, lastTimestamp: BigInt, isContractInitialized: boolean}>}
     */
    async __getAggregatedTrades(timestamp) {
        let aggregatedTrades = await aggregateTrades({
            contract: this.__reflector.oracleId,
            baseAsset: this.__reflector.baseAsset.getStellarAsset(),
            assets: container.settingsManager.getAssets(true).map(a => a.getStellarAsset()),
            decimals: this.__reflector.decimals,
            from: timestamp / 1000,
            period: this.__reflector.timeframe / 1000
        })
        aggregatedTrades = aggregatedTrades || {}
        aggregatedTrades.isContractInitialized = !!aggregatedTrades.admin
        container.statisticsManager.setLastOracleData(Number(aggregatedTrades.lastTimestamp), aggregatedTrades.isContractInitialized)
        return aggregatedTrades
    }

    /**
     * @returns {Promise<Account>}
     */
    async __getAccount() {
        try {
            const accountProps = await retrieveAccountProps(this.__reflector.admin)
            return new Account(this.__reflector.admin, accountProps.sequence.toString())
        } catch (e) {
            logger.error(e)
            throw e
        }
    }

    /**
     * @param {PendingTransactionBase} tx - transaction
     */
    __setPendingTransaction(tx) {
        if (this.__pendingTransaction) {
            logger.error(`Pending transaction wasn't submitted. Tx type: ${this.__pendingTransaction.type}, tx timestamp: ${this.__pendingTransaction.timestamp}.`)
            this.__clearPendingTransaction()
        }

        const signature = this.__keypair.signDecorated(tx.hash)
        tx.addSignature(signature)

        this.__tryAssignPendingSignatures(tx.hashHex, tx)
        this.__pendingTransaction = tx
        __broadcastSignature(tx)
    }

    __clearPendingTransaction() {
        if (!(this.__pendingTransaction?.type === PendingTransactionType.PRICE_UPDATE
            || this.__pendingTransaction?.type === PendingTransactionType.INIT))
            container.settingsManager.applyUpdate()
        this.__pendingTransaction = null
    }

    /**
     * @param {number} timestamp - normalized timestamp
     * @returns {Promise<void>}
     */
    async __priceUpdateWorker(timestamp) {
        if (!this.isRunning)
            return
        try {
            const aggregatedTrades = await this.__getAggregatedTrades(timestamp - this.__reflector.timeframe)
            if (!aggregatedTrades?.admin //not initialized yet, skip this round
                || aggregatedTrades.lastTimestamp >= timestamp //this data already processed, skip this round
                || aggregatedTrades.prices.length !== container.settingsManager.getAssets(true).length) //config is changed, skip this round
                return
            const tx = await this.__oracleClient.setPrice(
                await this.__getAccount(),
                aggregatedTrades.prices,
                timestamp,
                this.__txOptions
            )
            this.__setPendingTransaction(new PriceUpdatePendingTransaction(tx, timestamp, aggregatedTrades.prices))
        } catch (e) {
            logger.error(e)
        } finally {
            const nextTimestamp = timestamp + this.__reflector.timeframe
            const timeout = nextTimestamp + this.__dbSyncDelay - Date.now()
            logger.debug(`Next price update: ${nextTimestamp}, timeout: ${timeout}, dbSyncDelay: ${this.__dbSyncDelay}`)
            this.__priceUpdateWorkerTimeout = setTimeout(() => this.__priceUpdateWorker(nextTimestamp), Number(timeout))
        }
    }

    __tryAssignPendingSignatures(hash, pendingTx) {
        //add pending signatures if any
        const signaturesData = this.__pendingSignatures[hash]
        if (signaturesData)
            for (const signature of signaturesData.signatures)
                pendingTx.addSignature(signature)
        delete this.__pendingSignatures[hash]
    }


    /**
     * @returns {Promise<void>}
     */
    async __submitWorker() {
        if (!this.isRunning)
            return
        const tx = this.__pendingTransaction
        try {
            if (!tx || !tx.isReadyToSubmit(this.__reflector.nodes.length)) {
                return
            }
            this.__clearPendingTransaction() //clear pending transaction to avoid duplicate submission
            await this.__oracleClient.submitTransaction(tx.transaction, tx.getMajoritySignatures(this.__reflector.nodes.length))
            container.statisticsManager.incSubmittedTransactions()
        } catch (e) {
            if (e.message !== 'Transaction submit failed: DUPLICATE' && e.message !== 'Transaction submit failed: TRY_AGAIN_LATER') {
                logger.error(`Error in submit worker. Tx type: ${tx?.type}, tx hash: ${tx?.hashHex}, tx: ${tx.transaction.toXDR()}`)
                logger.error(e)
            }
        } finally {
            setTimeout(() => this.__submitWorker(), 1000)
        }
        container.statisticsManager.setLastProcessedTimestamp(tx.timestamp)
        logger.debug(`Transaction is submitted. ${tx.getDebugInfo()}`)
    }
}

module.exports = TransactionsManager