/**
 * @typedef {import('./channel-types')} ChannelTypes
 * @typedef {import('soroban-client').Keypair} Keypair
 */

const WebSocket = require('ws')
const {v4: uuidv4} = require('uuid')
const logger = require('../../logger')
const container = require('../../domain/container')

const isDev = process.env.NODE_ENV === 'development'


class BaseWebSocketChannel {

    /**
     * @param {string} pubkey - the pubkey of the node
     * */
    constructor(pubkey) {
        if (this.constructor === BaseWebSocketChannel)
            throw new Error('BaseWebSocketChannel is abstract class')
        if (!pubkey)
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

    removeAllListeners() {
        this.__ws?.removeAllListeners()
    }

    /**
     * @param {any} message - message to send
     * @returns {Promise<any>}
     */
    send(message) {
        return new Promise((resolve, reject) => {
            if (!message.responseId) {
                message.requestId = uuidv4()
                const responseTimeout = setTimeout(() => {
                    delete this.__requests[message.requestId]
                    const error = new Error('Request timed out')
                    error.timeout = true
                    reject(error)
                }, 5000)
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
                        if (message.resonseId)
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
        if (this.__ws) {
            this.__ws.removeAllListeners()
            this.__ws.closeTimeout = setTimeout(() => {
                if (this.__ws.readyState !== WebSocket.CLOSED) {
                    logger.debug('Server did not close connection in time, forcefully closing')
                    this.__ws.terminate()
                }
            }, 5000)
            if (this.__ws.readyState === WebSocket.CONNECTING || this.__ws.readyState === WebSocket.OPEN) {
                this.__ws.close(code, reason)
            }
        }
        this.__isValidated = false
    }

    /**
     * @protected
     */
    __assignListeners() {
        this.__ws
            .addListener('close', (code, reason) => this.__onClose(code, reason))
            .addListener('error', (error) => this.__onError(error))
            .addListener('message', async (message) => await this.__onMessage(message))
    }

    /**
     * @protected
     */
    __onOpen() {
        this.__assignListeners()
    }

    /**
     * @param {any} rawMessage - message from websocket
     * @protected
     */
    async __onMessage(rawMessage) {
        try {
            const message = JSON.parse(rawMessage)
            let result = undefined
            if (message.type !== undefined) //message requires handling
                result = await container.handlersManager.handle(this, message) || {}
            if (message.requestId) { //message requires response
                result.responseId = message.requestId
                await this.send(result)
                return
            }
            if (message.responseId) {
                const request = this.__requests[message.responseId]
                if (request) {
                    delete this.__requests[message.responseId]
                    clearTimeout(request.responseTimeout)
                    request.resolve(result) //resolve the promise with the result
                }
            }
        } catch (e) {
            this.__onError(e)
        }
    }

    __onClose(code, reason) {
        if (this.__ws) {
            this.__ws.closeTimeout && clearTimeout(this.__ws.closeTimeout)
            this.__ws.terminate()
            this.__ws = null
            this.__isValidated = false
        }
        logger.debug(`${this.pubkey} ${this.type} closed with code ${code} and reason ${reason}`)
    }

    __onError(error) {
        if (error.code === 'ECONNREFUSED' || error.code === 'EAI_AGAIN') {
            if (error.connectionAttempts > 0 && error.connectionAttempts % 20 === 0)
                logger.debug(`${this.pubkey} ${this.type} websocket error ${error.code}. Connection attempts: ${error.connectionAttempts}`)
        } else {
            logger.debug(`${this.pubkey} ${this.type} websocket error`)
            logger.debug(error)
        }
    }
}

module.exports = BaseWebSocketChannel