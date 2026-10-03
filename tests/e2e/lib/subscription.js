const path = require('path')
const {createPrivateKey, createPublicKey} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const {importRSAKey, encrypt} = require('../../../src/utils/crypto-helper')
const {short} = require('./wait')

const tokenDataPath = path.join(__dirname, '..', '..', 'cluster', 'token-data.json')

/**
 * The issuer of a token the cluster bootstrap created: it can pay any deposit or fee in it
 * @param {string} tokenId - token contract id
 * @returns {?Keypair}
 */
function tokenIssuer(tokenId) {
    let tokens
    try {
        tokens = require(tokenDataPath)
    } catch (err) {
        return null
    }
    const token = Object.values(tokens).find(t => t.tokenId === tokenId)
    return token?.secret ? Keypair.fromSecret(token.secret) : null
}

/**
 * Encrypts a webhook url for the cluster: nodes decrypt it with the cluster secret, so it is encrypted with that key's
 * public half
 * @param {string} clusterSecret - base64 PKCS#8 RSA private key from the cluster config
 * @param {string} url - webhook url
 * @returns {Promise<Uint8Array>}
 */
async function encryptWebhook(clusterSecret, url) {
    const privateKey = createPrivateKey({key: Buffer.from(clusterSecret, 'base64'), format: 'der', type: 'pkcs8'})
    const spki = createPublicKey(privateKey).export({format: 'der', type: 'spki'})
    return encrypt(await importRSAKey(spki), url)
}

function isqrt(value) {
    if (value < 2n)
        return value
    let x = value
    let y = (x + 1n) / 2n
    while (y < x) {
        x = y
        y = (x + value / x) / 2n
    }
    return x
}

/**
 * The daily fee the subscriptions contract charges, as its calc_fee computes it. It burns twice this to create a
 * subscription and keeps one alive for balance / fee days, refusing a balance that would outlive the ledger's maximum TTL
 * @param {number|string} baseFee - contract base fee
 * @param {number} heartbeat - heartbeat in minutes
 * @param {boolean} sameSource - whether base and quote come from the same source
 * @returns {bigint}
 */
function retentionFee(baseFee, heartbeat, sameSource) {
    const base = BigInt(baseFee)
    const heartbeatFee = isqrt(120n * base * base / BigInt(heartbeat))
    return (heartbeatFee < base ? base : heartbeatFee) * (sameSource ? 1n : 2n)
}

function parse(content) {
    try {
        return JSON.parse(content)
    } catch (err) {
        return null
    }
}

/**
 * Judges the notifications a webhook received for one subscription. Each node posts its own copy, signed over the
 * update with the gateway-restorable fields put back
 * @param {object[]} requests - requests the webhook received, each with its method and content
 * @param {object} expected - contractId, subscriptionId and members, the current node keys
 * @returns {{verifiers: string[], problems: string[]}} members that sent a valid notification, and what was wrong
 */
function verifyNotifications(requests, {contractId, subscriptionId, members}) {
    const verifiers = new Set()
    const problems = []
    for (const request of requests) {
        if (request.method !== 'POST')
            continue
        const data = parse(request.content)
        const {update, signature, verifier} = data || {}
        if (!update || update.contract !== contractId || update.event?.subscription !== String(subscriptionId))
            continue
        if (!members.includes(verifier)) {
            problems.push(`notification from ${short(String(verifier))}, not a cluster node`)
            continue
        }
        const signed = Buffer.from(JSON.stringify(sortObjectKeys(update)))
        let valid = false
        try {
            valid = Keypair.fromPublicKey(verifier).verify(signed, Buffer.from(String(signature), 'base64'))
        } catch (err) {
            valid = false
        }
        if (!valid) {
            problems.push(`invalid signature from ${short(verifier)}`)
            continue
        }
        verifiers.add(verifier)
    }
    return {verifiers: [...verifiers], problems}
}

module.exports = {tokenIssuer, encryptWebhook, verifyNotifications, retentionFee}
