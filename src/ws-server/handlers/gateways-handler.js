const {getDataHash, verifySignature} = require('@reflector/reflector-shared')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const nonceManager = require('../nonce-manager')
const BaseHandler = require('./base-handler')

function validateMessage(message, getDataFn) {
    if (!message.data)
        throw new Error('Data is required')
    const {publicKey} = container.settingsManager.appConfig
    const {signature, nonce, data} = getDataFn()
    if (!nonce || !signature)
        throw new Error('Nonce and signature are required')

    const verified = verifySignature(
        publicKey,
        signature,
        getDataHash(data, publicKey)
    )
    if (nonceManager.getNonce(nonceManager.nonceTypes.GATEWAYS) >= data.nonce //if nonce is outdated
        || !verified) //if signature is invalid
        throw new Error('Signature or nonce is not valid')

    nonceManager.setNonce(nonceManager.nonceTypes.GATEWAYS, data.nonce)
}


class GatewaysGetHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle(_, message) {
        const getDataFn = () => {
            const {signature, data} = message.data
            const split = data.payload.split('?')
            const uri = new URLSearchParams(split.length > 1 ? split[1] : data.payload)
            const nonce = parseInt(uri.get('nonce'), 10)
            return {signature, nonce, data: data.payload}
        }
        validateMessage(message, getDataFn)
        const {settingsManager} = container
        const {urls, challenge} = settingsManager.gateways
        return {urls, challenge}
    }
}

class GatewaysPostHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle(_, message) {
        const getDataFn = () => {
            const {signature, data} = message.data
            return {signature, nonce: data.nonce, data}
        }
        validateMessage(message, getDataFn)
        const {settingsManager} = container
        const gateways = {urls: message.data.data.urls, challenge: message.data.data.challenge}
        settingsManager.setGateways(gateways)
    }
}

module.exports = {GatewaysGetHandler, GatewaysPostHandler}