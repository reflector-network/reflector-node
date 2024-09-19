const {Transaction, SorobanRpc} = require('@stellar/stellar-sdk')
const {normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../logger')

/**
 * @typedef {import('@stellar/stellar-sdk').Account} Account
 * @typedef {import('@stellar/stellar-sdk').SorobanRpc.Api.SendTransactionResponse} SendTransactionResponse
 * @typedef {import('@stellar/stellar-sdk').SorobanRpc.Api.GetFailedTransactionResponse} GetFailedTransactionResponse
 * @typedef {import('@stellar/stellar-sdk').SorobanRpc.Api.GetSuccessfulTransactionResponse} GetSuccessfulTransactionResponse
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
 * @param {SorobanRpc.Server} server - soroban rpc server
 * @returns {Promise<any>}
 */

/**
 * @param {string[]} urls - urls
 * @param {RequestFunction} requestFn - request function
 * @returns {Promise<any>}
 */
async function makeServerRequest(urls, requestFn) {
    const errors = []
    for (const url of urls) {
        try {
            const server = new SorobanRpc.Server(url, {allowHttp: true})
            return await requestFn(server)
        } catch (err) {
            logger.debug(`Request to ${url} failed. Error: ${err.message}`)
            errors.push(err)
        }
    }
    for (const err of errors)
        logger.error(err)
    throw new Error('Failed to make request. See logs for details.')
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

    logger.debug(`Account: ${pendingTx.transaction.source}, sequence: ${pendingTx.transaction.sequence}, fee: ${pendingTx.transaction.fee}, maxTime: ${maxTime}, currentTime: ${currentTimeInSeconds}, transaction: ${hash}`)

    const txXdr = pendingTx.transaction.toXDR() //Get the raw XDR for the transaction to avoid modifying the transaction object
    const tx = new Transaction(txXdr, network) //Create a new transaction object from the XDR

    function processResponse(response) {
        const error = getSubmissionError(response, txXdr)
        attempts--
        if (error.errorName === 'TRY_AGAIN_LATER' || error.errorName === 'NOT_FOUND') {
            return
        } else if ((error.errorName === 'txBadSeq' || error.errorName === 'txTooLate') && !falseErrorHandled) { //when tx is already submitted, but was not found, txBadSeq or txTooLate can be thrown on submit
            logger.debug(`${error.errorName} error. Retry attempt. ${runnerInfo}. Tx type: ${pendingTx.type}, hash: ${hash}, falseErrorHandled: ${falseErrorHandled}`)
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
            logger.debug(`Transaction is too late. ${runnerInfo}. Tx type: ${pendingTx.type}, hash: ${hash}, maxTime: ${maxTime}, latestLedgerCloseTime: ${latestLedgerCloseTime}`)
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
            logger.trace(`Transaction is already submitted. ${runnerInfo}. Tx type: ${pendingTx.type}, hash: ${hash}`)
            response.hash = hash
            return response
        }

        //submit the transaction if it's not found
        if (response.status === 'NOT_FOUND') {
            ensureIsNotTimedOut()
            const sendTransactionFn = async (server) => await server.sendTransaction(tx)
            const submitResult = await makeServerRequest(sorobanRpc, sendTransactionFn)
            logger.debug(`Transaction is sent. ${runnerInfo}. Tx type: ${pendingTx.type}, hash: ${hash}, status: ${submitResult.status}`)
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
    throw new Error(`Failed to submit transaction. ${runnerInfo}. Tx type: ${pendingTx.type}, hash: ${hash}`)
}

/**
 * @param {string} contractId - contract id
 * @param {number} depth - depth in seconds (only used when pagingToken is not provided)
 * @param {string} pagingToken - paging token
 * @param {string[]} sorobanRpc - soroban rpc urls
 * @returns {Promise<{events: any[], pagingToken: string}>}
 */
async function getLastContractEvents(contractId, depth, pagingToken, sorobanRpc) {
    const limit = 100
    const lastLedger = (await makeServerRequest(sorobanRpc, async (server) => await server.getLatestLedger())).sequence
    const startLedger = lastLedger - Math.ceil(depth / 5) //1 ledger is closed every 5 seconds
    const loadEvents = async (startLedger, cursor) => {
        const d = await makeServerRequest(sorobanRpc, async (server) => {
            startLedger = cursor ? undefined : startLedger
            const data = await server.getEvents({filters: [{type: 'contract', contractIds: [contractId]}], startLedger, limit, cursor})
            return data
        })
        return d
    }
    let events = []
    let hasMore = true
    while (hasMore) {
        const eventsResponse = (await loadEvents(startLedger, pagingToken))
        if (eventsResponse.events.length < limit)
            hasMore = false
        if (eventsResponse.events.length === 0)
            break
        events = events.concat(eventsResponse.events)
        pagingToken = eventsResponse.events[eventsResponse.events.length - 1].pagingToken
    }
    return {events, pagingToken}
}

/**
 * @param {string} account - account address
 * @param {string[]} sorobanRpc - soroban rpc urls
 * @returns {Account}
 */
async function getAccount(account, sorobanRpc) {
    return await makeServerRequest(sorobanRpc, async (server) => await server.getAccount(account))
}

module.exports = {submitTransaction, getLastContractEvents, getAccount, txTimeoutMessage}