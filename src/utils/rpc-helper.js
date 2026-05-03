const {Transaction, rpc} = require('@stellar/stellar-sdk')
const {normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../logger')

/**
 * @typedef {import('@stellar/stellar-sdk').Account} Account
 * @typedef {import('@stellar/stellar-sdk').rpc.Api.SendTransactionResponse} SendTransactionResponse
 * @typedef {import('@stellar/stellar-sdk').rpc.Api.GetFailedTransactionResponse} GetFailedTransactionResponse
 * @typedef {import('@stellar/stellar-sdk').rpc.Api.GetSuccessfulTransactionResponse} GetSuccessfulTransactionResponse
 * @typedef {import('@reflector/reflector-shared').PendingTransactionBase} PendingTransactionBase
 */

const txTimeoutMessage = 'Tx timed out.'

/**
 * @param {SendTransactionResponse|GetFailedTransactionResponse} submitResult - transaction submit result
 * @param {string} txXdr - transaction xdr for fallback
 * @returns {Error}
 */
function getSubmissionError(submitResult, txXdr) {
    const resultXdr = (submitResult.resultXdr ?? submitResult.errorResult)
    const {name: errorName, value: code} = resultXdr?.result()?.switch() ?? {}
    const error = new Error(`Transaction submit failed: ${submitResult.status}. Error name: ${errorName}, code: ${code}`)
    error.status = submitResult.status
    error.errorResultXdr = resultXdr?.toXDR('base64') ?? null
    error.hash = submitResult.hash
    error.meta = submitResult.resultMetaXdr?.toXDR('base64') ?? null
    error.tx = submitResult.envelopeXdr?.toXDR('base64') ?? txXdr
    error.latestLedgerCloseTime = submitResult.latestLedgerCloseTime
    error.code = code
    error.errorName = errorName ?? submitResult.status
    return error
}

/**
 * @callback RequestFunction
 * @param {rpc.Server} server - soroban rpc server
 * @returns {Promise<any>}
 */

/**
 * @param {string[]} sorobanRpc - urls
 * @param {RequestFunction} requestFn - request function
 * @returns {Promise<any>}
 */
async function makeServerRequest(sorobanRpc, requestFn) {
    if (!sorobanRpc || sorobanRpc.length < 1)
        throw new Error('No soroban rpc urls provided')
    for (let i = 0; i < 3; i++) { //max 3 attempts
        const errAggr = []
        try {
            for (const serverRpc of sorobanRpc) {
                try {
                    const server = new rpc.Server(serverRpc, {allowHttp: true})
                    return await requestFn(server)
                } catch (e) {
                    errAggr.push({url: serverRpc, err: e})
                }
            }
            throw new Error('Failed to invoke RPC method on all provided URLs', {cause: {errAggr}})
        } catch (e) {
            if (i === 2) {
                throw e
            }
            console.warn({msg: 'RPC call failed, retrying', attempt: i + 1, err: e?.cause?.errAggr || e.message})
        }
        await new Promise(resolve => setTimeout(resolve, 300))
    }
}

/**
 * @param {string} network - network
 * @param {string[]} sorobanRpc - soroban rpc urls
 * @param {PendingTransactionBase} pendingTx - transaction
 * @param {DecoratedSignature[]} signatures - signatures
 * @param {string} runnerInfo - runner info
 * @returns {Promise<GetSuccessfulTransactionResponse>}
 */
async function submitTransaction(network, sorobanRpc, pendingTx, signatures, runnerInfo) {
    let attempts = 100
    const hash = pendingTx.hashHex
    let falseErrorHandled = false

    const maxTime = Number(pendingTx.transaction.timeBounds.maxTime)
    const currentTimeInSeconds = normalizeTimestamp(Date.now(), 1000) / 1000

    logger.debug({msg: 'Submitting transaction', ...runnerInfo, account: pendingTx.transaction.source, sequence: pendingTx.transaction.sequence, fee: pendingTx.transaction.fee, maxTime, currentTime: currentTimeInSeconds, hash})

    const txXdr = pendingTx.transaction.toXDR() //Get the raw XDR for the transaction to avoid modifying the transaction object
    const tx = new Transaction(txXdr, network) //Create a new transaction object from the XDR

    function processResponse(response) {
        const error = getSubmissionError(response, txXdr)
        attempts--
        if (error.errorName === 'TRY_AGAIN_LATER' || error.errorName === 'NOT_FOUND') {
            return
        } else if ((error.errorName === 'txBadSeq' || error.errorName === 'txTooLate') && !falseErrorHandled) { //when tx is already submitted, but was not found, txBadSeq or txTooLate can be thrown on submit
            logger.debug({msg: `${error.errorName} error. Retry attempt`, ...runnerInfo, txType: pendingTx.type, hash, falseErrorHandled})
            falseErrorHandled = true
            return
        }
        throw error
    }

    signatures.forEach(signature => tx.addDecoratedSignature(signature))

    let isTxTooLate = false
    let latestLedgerCloseTime = 0

    const ensureIsNotTimedOut = () => {
        if (isTxTooLate) {
            logger.debug({msg: `Transaction is too late`, ...runnerInfo, txType: pendingTx.type, hash, maxTime, latestLedgerCloseTime})
            throw new Error(txTimeoutMessage)
        }
    }

    while (attempts > 0) {
        const getTransactionFn = async (server) => {
            const response = await server.getTransaction(hash)
            latestLedgerCloseTime = response.latestLedgerCloseTime
            isTxTooLate = maxTime < latestLedgerCloseTime
            return response
        }
        //check if the transaction is already submitted
        let response = await makeServerRequest(sorobanRpc, getTransactionFn)
        if (response.status === 'SUCCESS') {
            logger.trace({msg: `Transaction is already submitted`, ...runnerInfo, txType: pendingTx.type, hash})
            response.hash = hash
            return response
        }

        //submit the transaction if it's not found
        if (response.status === 'NOT_FOUND') {
            ensureIsNotTimedOut()
            const sendTransactionFn = async (server) => await server.sendTransaction(tx)
            const submitResult = await makeServerRequest(sorobanRpc, sendTransactionFn)
            logger.debug({msg: `Transaction is sent`, ...runnerInfo, txType: pendingTx.type, hash, status: submitResult.status})
            if (!['PENDING', 'DUPLICATE'].includes(submitResult.status)) {
                processResponse(submitResult)
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }
        } else if (response.status === 'FAILED') {
            processResponse(response)
        }

        response = await makeServerRequest(sorobanRpc, getTransactionFn)
        let getResultAttempts = 10
        while ((response.status === 'PENDING' || response.status === 'NOT_FOUND') && getResultAttempts > 0) {
            ensureIsNotTimedOut()
            await new Promise(resolve => setTimeout(resolve, 500))
            response = await makeServerRequest(sorobanRpc, getTransactionFn)
            getResultAttempts--
        }

        response.hash = hash //Add hash to response to avoid return new object
        if (response.status !== 'SUCCESS') {
            processResponse(response)
            continue
        }
        return response
    }
    throw new Error(`Failed to submit transaction. ${JSON.stringify(runnerInfo)}. Tx type: ${pendingTx.type}, hash: ${hash}`)
}

/**
 * @param {string} contractId - contract id
 * @param {number} lastProcessedLedger - last processed ledger
 * @param {string[]} sorobanRpc - soroban rpc urls
 * @returns {Promise<{events: any[], lastLedger: number}>}
 */
async function getLastContractEvents(contractId, lastProcessedLedger, sorobanRpc) {
    const limit = 1000
    const events = new Map()
    let hasMore = true
    let latestLedger = null
    let cursorLedger = null
    while (hasMore) {
        const eventsResponse = await loadEvents(cursorLedger ? cursorLedger : lastProcessedLedger, limit, sorobanRpc, contractId)
        if (eventsResponse.events.length < limit)
            hasMore = false
        latestLedger = eventsResponse.latestLedger
        if (eventsResponse.events.length === 0)
            break
        eventsResponse.events.forEach(e => events.set(e.id, e))
        cursorLedger = eventsResponse.events[eventsResponse.events.length - 1].ledger - 1
        logger.debug({msg: 'Loaded events', contract: contractId, eventCount: events.size, hasMore, lastEventLedger: cursorLedger})
    }

    return {events: [...events.values()], lastLedger: latestLedger}
}

/**
 * @param {string[]} sorobanRpc - soroban rpc urls
 * @param {string} contractId - contract id
 * @returns {Promise<{oldestLedger: number, latestLedger: number}>}
 */
async function getEventsLedgerInfo(sorobanRpc, contractId) {
    const lastLedger = await makeServerRequest(sorobanRpc, async (server) => (await server.getLatestLedger())?.sequence)
    const {oldestLedger, latestLedger} = await loadEvents(lastLedger, 1, sorobanRpc, contractId)
    return {oldestLedger, latestLedger}
}

async function loadEvents(startLedger, limit, sorobanRpc, contractId) {
    return await makeServerRequest(sorobanRpc, async (server) => {
        try {
            const data = await server.getEvents({filters: [{type: 'contract', contractIds: [contractId]}], startLedger, limit})
            return data
        } catch (e) {
            logger.error({msg: 'Error loading events', contract: contractId, startLedger, err: e.message})
            throw e
        }
    })
}

/**
 * @param {string} account - account address
 * @param {string[]} sorobanRpc - soroban rpc urls
 * @returns {Account}
 */
async function getAccount(account, sorobanRpc) {
    return await makeServerRequest(sorobanRpc, async (server) => await server.getAccount(account))
}

module.exports = {submitTransaction, getLastContractEvents, getAccount, getEventsLedgerInfo, txTimeoutMessage}