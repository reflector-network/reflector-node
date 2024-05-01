const WebSocket = require('ws')
const {v4: uuidv4} = require('uuid')
const logger = require('../../logger')
const container = require('../../domain/container')
const MessageTypes = require('../handlers/message-types')
const {isDebugging} = require('../../utils')
const ChannelTypes = require('./channel-types')

class ChannelBase {

    /**
     * @param {string} pubkey - the pubkey of the node
     * */
    constructor(pubkey) {
        if (this.constructor === ChannelBase)
            throw new Error('BaseWebSocketChannel is abstract class')
        if (!pubkey && this.constructor.name !== 'OrchestratorChannel')
            throw new Error('pubkey is required')
        this.pubkey = pubkey
    }

    /**
     * @type {WebSocket.WebSocket}
     */
    __ws = null

    /**
     * @type {[string]: {resolve: (value: any) => void, reject: (reason?: any) => void}}
     */
    __requests = {}

    /**
     * @type {string}
     */
    pubkey = null

    /**
     * @type {ChannelTypes}
     */
    type = null

    /**
     * @type {string}
     */
    authPayload = null

    get isOpen() {
        return this.__ws?.readyState === WebSocket.OPEN
    }

    validated() {
        this.__isValidated = true
    }

    __isValidated = false

    //eslint-disable-next-line class-methods-use-this
    get isValidated() {
        return this.__isValidated
    }

    get isReady() {
        return this.isOpen && this.isValidated
    }

    /**
     * @param {any} message - message to send
     * @returns {Promise<any>}
     */
    send(message) {
        return new Promise((resolve, reject) => {
            if (!message.responseId) {
                message.requestId = uuidv4()
                const timeout = isDebugging() ? 60 * 1000 * 60 : 5000
                const responseTimeout = setTimeout(() => {
                    delete this.__requests[message.requestId]
                    const error = new Error(`Request timed out after ${timeout}. Message: ${message.type}. ${this.__getConnectionInfo()}`)
                    error.timeout = true
                    reject(error)
                }, timeout)
                this.__requests[message.requestId] = {
                    resolve,
                    reject,
                    responseTimeout
                }
            }
            try {
                this.__ws.send(JSON.stringify(message), (err) => {
                    if (err) {
                        reject(err)
                    } else {
                        if (message.responseId)
                            resolve()
                    }
                })
            } catch (err) {
                reject(err)
            }
        })
    }

    close(code, reason, terminate = true) {
        this.__termination = terminate
        const ws = this.__ws
        if (ws) {
            ws.closeTimeout = setTimeout(() => {
                ws.close(code, reason)
            }, 5000)
            if (ws.readyState === WebSocket.CONNECTING) {
                ws.removeAllListeners('open')
                ws.on('open', () => {
                    ws.close(code, reason)
                })
            } else if (ws.readyState === WebSocket.OPEN) {
                ws.close(code, reason)
            } else if (ws.readyState === WebSocket.CLOSED) {
                this.__closeAndInvalidate(ws, code, reason)
            }
        }
    }

    /**
     * @protected
     * @returns {WebSocket.WebSocket}
     */
    __assignListeners() {
        return this.__ws
            .addListener('close', (code, reason) => this.__onClose(code, reason))
            .addListener('error', (error) => this.__onError(error))
            .addListener('message', async (message) => await this.__onMessage(message))
    }

    /**
     * @param {any} rawMessage - message from websocket
     * @protected
     */
    async __onMessage(rawMessage) {
        try {
            const message = JSON.parse(rawMessage)
            let result = undefined
            if (message.type !== undefined
                && [MessageTypes.ERROR, MessageTypes.OK].indexOf(message.type) === -1
            ) //message requires handling
                try {
                    result = await container.handlersManager.handle(this, message) || {type: MessageTypes.OK, responseId: message.requestId}
                } catch (e) {
                    logger.debug(e)
                    result = {
                        type: MessageTypes.ERROR,
                        error: e.message,
                        responseId: message.requestId
                    }
                }
            else
                result = message
            if (message.requestId) { //message requires response
                if (!result)
                    result = {type: MessageTypes.ERROR, error: 'No response'}
                else if (result.type === undefined)
                    result = {type: MessageTypes.OK, data: result}
                result.responseId = message.requestId
                await this.send(result)
                return
            }
            if (message.responseId) {
                const request = this.__requests[message.responseId]
                if (request) {
                    delete this.__requests[message.responseId]
                    clearTimeout(request.responseTimeout)
                    if (message.type === MessageTypes.ERROR)
                        request.reject(new Error(message.error))
                    else
                        request.resolve(result.data) //resolve the promise with the result
                }
            }
        } catch (e) {
            this.__onError(e)
        }
    }

    __onClose(code, reason) {
        this.__closeAndInvalidate(this.__ws, code, reason)
    }

    __closeAndInvalidate(ws, code, reason) {
        if (!ws)
            return
        ws.closeTimeout && clearTimeout(ws.closeTimeout)
        if (ws.readyState !== WebSocket.CLOSED) {
            logger.warn(`${this.__getConnectionInfo()} was not closed properly (${ws.readyState}). Terminating...`)
            try {
                ws.terminate()
            } catch (e) {
                logger.error(e)
            }
        }
        if (this.__ws === ws) {
            this.__ws = null
            this.__isValidated = false
        }
        logger.debug(`${this.__getConnectionInfo()} closed with code ${code} and reason ${reason || 'abnormal'}`)
    }

    __onError(error) {
        logger.trace(`${this.__getConnectionInfo()} websocket error. ${error.code}`)
        if (error.code === 'ECONNREFUSED' || error.code === 'EAI_AGAIN' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            if (error.connectionAttempts > 0 && error.connectionAttempts % 100 === 0)
                logger.debug(`${this.__getConnectionInfo()} websocket error ${error.code}. Connection attempts: ${error.connectionAttempts}`)
        } else {
            logger.debug(`${this.__getConnectionInfo()} websocket error`)
            logger.debug(error)
        }
    }

    __getConnectionInfo() {
        return `${this.type === ChannelTypes.ORCHESTRATOR ? 'Orchestrator' : this.pubkey} ${this.type} ${this.__ws?.id || 'N/A'}`
    }
}

module.exports = ChannelBase