const {StrKey} = require('@stellar/stellar-sdk')
const {getDataHash, verifySignature} = require('@reflector/reflector-shared')
const container = require('../../domain/container')
const logger = require('../../logger')
const nonceManager = require('../nonce-manager')

const signaturePattern = /^[0-9a-f]{128}$/i

/**
 * Splits the route binding node-orchestrator signs (server/middlewares.js buildRouteBinding): the route path without
 * its leading slash, then every query parameter and the nonce, sorted together
 * @param {any} binding - signed route binding
 * @returns {{path: string, params: URLSearchParams}}
 */
function parseRouteBinding(binding) {
    if (typeof binding !== 'string')
        throw new Error('Signed route binding is required')
    const separator = binding.indexOf('?')
    if (separator < 0)
        throw new Error('Signed route binding carries no nonce')
    return {path: binding.slice(0, separator), params: new URLSearchParams(binding.slice(separator + 1))}
}

/**
 * Verifies a control message the orchestrator relays for an operator: the operator's signature over
 * exactly the payload node-orchestrator's middleware verified, the route and the node it was signed for, and a nonce
 * that only moves forward per message type and signer. The payload is `sortObjectKeys({...body, nonce, path})` for a
 * POST and the route binding string for a GET, hashed as sha256(`${pubkey}:${JSON.stringify(payload)}`), which is
 * getDataHash(payload, pubkey). Throws when any check fails; the handler then does nothing
 * @param {any} message - relayed message; its data carries {data, signature, pubkey}
 * @param {string} nonceType - nonceManager.nonceTypes entry of the message type
 * @param {string} expectedPath - the route the payload must have been signed for
 * @param {{method: string, ownKeyOnly: boolean}} options - method: 'GET' or 'POST', the shape the payload must have;
 * ownKeyOnly: only this node's own key may sign the message
 * @returns {{signer: string, payload: any}}
 */
function verifyControlMessage(message, nonceType, expectedPath, {method, ownKeyOnly = false}) {
    const relayed = message?.data
    if (!relayed || typeof relayed !== 'object')
        throw new Error('Data is required')
    const {data: payload, signature, pubkey: signer} = relayed
    if (typeof signer !== 'string' || !StrKey.isValidEd25519PublicKey(signer))
        throw new Error('Signer public key is required')
    if (typeof signature !== 'string' || !signaturePattern.test(signature))
        throw new Error('Signature is required')
    //a GET signs the route binding string, a POST an object carrying it: one cannot pass for the other
    const isPost = !!payload && typeof payload === 'object' && !Array.isArray(payload)
    if (isPost !== (method === 'POST'))
        throw new Error('Signed request used another method')
    const {path, params} = parseRouteBinding(isPost ? payload.path : payload)
    if (path !== expectedPath)
        throw new Error('Signed request was made for another route')
    const nonce = Number(params.get('nonce'))
    if (!Number.isSafeInteger(nonce) || nonce <= 0)
        throw new Error('Signed request carries no valid nonce')
    if (isPost && payload.nonce !== nonce)
        throw new Error('Signed request carries two different nonces')
    const {publicKey} = container.settingsManager.appConfig
    if (ownKeyOnly && signer !== publicKey)
        throw new Error('Only this node key may change its trace setting')
    //the orchestrator authenticates cluster node keys only, so no honest relay carries another signer. This node
    //cannot tell which cluster key is the orchestrator's monitoringKey, so any cluster node key that names this node
    //with node=<this key> may list and read this node's logs, which are redacted; only SET_TRACE is kept to this
    //node's own key
    if (signer !== publicKey && !container.settingsManager.config?.nodes?.has(signer))
        throw new Error('Signer is not a cluster node')
    if (!verifySignature(signer, signature, getDataHash(payload, signer)))
        throw new Error('Signature is not valid')
    //no node parameter: the request is for the signer's own node; with one, it must name this node
    const target = params.get('node')
    if (target === null ? signer !== publicKey : target !== publicKey)
        throw new Error('Signed request is aimed at another node')
    //consumed only once the signature verified, so nobody without the key can move it
    const nonceKey = `${nonceType}:${signer}`
    if (nonceManager.getNonce(nonceKey) >= nonce)
        throw new Error('Nonce is outdated')
    nonceManager.setNonce(nonceKey, nonce)
    if (signer !== publicKey)
        logger.warn({msg: 'Control message signed by another cluster node key', messageType: nonceType, signer})
    return {signer, payload}
}

module.exports = {verifyControlMessage, parseRouteBinding}
