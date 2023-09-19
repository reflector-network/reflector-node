const {createHash} = require('crypto')
const fs = require('fs')
const container = require('../domain/container')
const logger = require('../logger')
const {unauthorized} = require('./errors')

const nonceFile = './home/nonce'

let lastNonce = fs.existsSync(nonceFile) ? Number(fs.readFileSync(nonceFile).toString().trim()) : null
if (lastNonce == null || isNaN(lastNonce)) {
    logger.warn('Nonce not found or invalid. Set to 0')
    setNonce(0) //set initial nonce
}

function setNonce(value) {
    lastNonce = value
    fs.writeFileSync(nonceFile, value.toString())
}

function validateSignature(req, res, next) {
    const nodeKeypair = container.settingsManager.config.keypair
    if (!nodeKeypair)
        return next()

    const {authorization} = req.headers
    if (!authorization)
        throw unauthorized('Authorization header is required')

    const method = req.method.toUpperCase()
    let payload = null
    let nonce = null
    if (method === 'GET') {
        nonce = Number(req.query.nonce)
        payload = new URLSearchParams(req.query).toString()
    } else if (method === 'POST') {
        nonce = req.body.nonce
        payload = req.body
    } else {
        throw unauthorized('Invalid request method')
    }

    if (!nonce || isNaN(nonce) || nonce <= lastNonce) {
        throw unauthorized('Invalid nonce')
    }

    const [_, signature] = authorization.split(' ')
    const messageToSign = `${container.settingsManager.config.publicKey}:${JSON.stringify(payload)}`
    const messageHash = createHash('sha256').update(messageToSign, 'utf8').digest()
    const isValid = nodeKeypair.verify(messageHash, Buffer.from(signature, 'hex'))
    if (!isValid)
        throw unauthorized('Invalid signature')
    setNonce(nonce)
    next()
}

module.exports = {validateSignature}