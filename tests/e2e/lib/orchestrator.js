const {createHash} = require('crypto')
const {Config, sortObjectKeys} = require('@reflector/reflector-shared')
const {readJson, writeJson, settings} = require('./env')

/**
 * Request and signature nonces, one strictly increasing counter per key, kept on disk so a rerun or an orchestrator
 * reset never reuses one
 */
class NonceStore {
    /**
     * @param {string} file - JSON file holding the last nonce per key
     */
    constructor(file) {
        this.file = file
        this.data = readJson(file, {})
    }

    /**
     * @param {string} pubkey - signer
     * @returns {number}
     */
    next(pubkey) {
        const nonce = Math.max((this.data[pubkey] || 0) + 1, Date.now())
        this.data[pubkey] = nonce
        writeJson(this.file, this.data)
        return nonce
    }
}

/**
 * @param {Keypair} keypair - signer
 * @param {any} payload - payload as the orchestrator rebuilds it
 * @returns {string} hex signature over sha256("<pubkey>:" + JSON.stringify(payload))
 */
function signPayload(keypair, payload) {
    const hash = createHash('sha256').update(`${keypair.publicKey()}:${JSON.stringify(payload)}`, 'utf8').digest()
    return Buffer.from(keypair.sign(hash)).toString('hex')
}

function routeBinding(route, query, nonce) {
    return route + '?' + new URLSearchParams(sortObjectKeys({...query, nonce})).toString()
}

function header(keypair, payload, nonce) {
    return `${keypair.publicKey()}.${signPayload(keypair, payload)}.${nonce}`
}

/**
 * @param {Keypair} keypair - signer
 * @param {string} route - route without the leading slash
 * @param {object} query - query parameters
 * @param {number} nonce - request nonce
 * @returns {string} authorization header
 */
function getRequestAuth(keypair, route, query, nonce) {
    return header(keypair, routeBinding(route, query, nonce), nonce)
}

/**
 * @param {Keypair} keypair - signer
 * @param {string} route - route without the leading slash
 * @param {object} body - request body
 * @param {number} nonce - request nonce
 * @returns {string} authorization header
 */
function postRequestAuth(keypair, route, body, nonce) {
    const parsed = JSON.parse(JSON.stringify(body))
    return header(keypair, sortObjectKeys({...parsed, nonce, path: routeBinding(route, {}, nonce)}), nonce)
}

/**
 * @param {Keypair} keypair - node key
 * @param {object} rawConfig - config to sign
 * @param {number} nonce - signature nonce
 * @param {boolean} [rejected] - a rejecting vote
 * @returns {{pubkey: string, nonce: number, rejected: boolean, signature: string}}
 */
function signConfig(keypair, rawConfig, nonce, rejected = false) {
    const hash = new Config(rawConfig).getSignaturePayloadHash(keypair.publicKey(), nonce, rejected)
    const signature = Buffer.from(keypair.sign(Buffer.from(hash, 'hex'))).toString('hex')
    return {pubkey: keypair.publicKey(), nonce, rejected, signature}
}

class OrchestratorClient {
    /**
     * @param {{baseUrl: string, nonces: NonceStore}} options - orchestrator url and nonce store
     */
    constructor({baseUrl, nonces}) {
        this.baseUrl = baseUrl.replace(/\/$/, '')
        this.nonces = nonces
    }

    async __request(method, route, {keypair = null, query = {}, body} = {}) {
        const headers = {}
        if (body !== undefined)
            headers['content-type'] = 'application/json'
        if (keypair) {
            const nonce = this.nonces.next(keypair.publicKey())
            headers.authorization = method === 'GET'
                ? getRequestAuth(keypair, route, query, nonce)
                : postRequestAuth(keypair, route, body, nonce)
        }
        const qs = new URLSearchParams(query).toString()
        const label = `${method} /${route}`
        let res
        try {
            res = await fetch(`${this.baseUrl}/${route}${qs ? '?' + qs : ''}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body)
            })
        } catch (err) {
            const error = new Error(`${label} failed: ${err.cause?.code || err.message}`)
            error.status = null
            throw error
        }
        const text = await res.text()
        let data = null
        try {
            data = text ? JSON.parse(text) : null
        } catch (err) {
            data = text
        }
        if (!res.ok) {
            const error = new Error(`${label} failed with ${res.status}: ${data?.error || data?.message || text}`)
            error.status = res.status
            error.body = data
            throw error
        }
        return data
    }

    /**
     * @param {Keypair} keypair - a key of the current node set
     * @returns {Promise<{currentConfig: ?object, pendingConfig: ?object}>}
     */
    getConfig(keypair) {
        return this.__request('GET', 'config', {keypair})
    }

    statistics() {
        return this.__request('GET', 'statistics')
    }

    nodes() {
        return this.__request('GET', 'nodes')
    }

    /**
     * Proposes a config or votes on the open one: the orchestrator treats an equal payload as a vote
     * @param {Keypair} keypair - voting node key
     * @param {object} rawConfig - proposed config
     * @param {object} [options] - envelope options: rejected, timestamp, expirationDate, allowEarlySubmission, description
     * @returns {Promise<{ok: number}>}
     */
    submit(keypair, rawConfig, {
        rejected = false,
        timestamp = 0,
        expirationDate = Date.now() + settings.expirationMs,
        allowEarlySubmission = false,
        description = 'e2e'
    } = {}) {
        const nonce = this.nonces.next(keypair.publicKey())
        const body = {
            config: rawConfig,
            signatures: [signConfig(keypair, rawConfig, nonce, rejected)],
            timestamp,
            expirationDate,
            allowEarlySubmission,
            description
        }
        return this.__request('POST', 'config', {keypair, body})
    }
}

module.exports = {NonceStore, OrchestratorClient, signConfig, getRequestAuth, postRequestAuth}
