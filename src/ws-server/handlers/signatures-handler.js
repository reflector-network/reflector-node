const {xdr} = require('soroban-client')
const {Keypair} = require('soroban-client')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class SignaturesHandler extends BaseHandler {

    constructor() {
        super()
    }

    allowedChannelTypes = ChannelTypes.OUTGOING

    async handle(ws, message) {
        const {signature, hash} = message.data
        if (!message.data.signature) {
            return
        }
        const signatureBuffer = Buffer.from(signature, 'hex')
        const decoratedSignature = xdr.DecoratedSignature.fromXDR(signatureBuffer, 'hex')
        const keypair = Keypair.fromPublicKey(ws.pubkey)
        if (keypair.verify(Buffer.from(hash, 'hex'), decoratedSignature.signature())) {
            const {transactionsManager} = container
            transactionsManager.addSignature(hash, xdr.DecoratedSignature.fromXDR(signatureBuffer, 'raw'))
        }
    }
}

module.exports = SignaturesHandler