const {xdr} = require('stellar-sdk')
const {Keypair} = require('stellar-sdk')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')

class SignaturesHandler extends BaseHandler {

    constructor() {
        super()
    }

    allowedChannelTypes = ChannelTypes.OUTGOING

    async handle(ws, message) {
        const {signature, hash, oracleId} = message.data
        if (!(signature && hash && oracleId)) {
            return
        }

        const oracleRunner = container.oracleRunnerManager.get(oracleId)
        if (!oracleRunner)
            return

        const signatureBuffer = Buffer.from(signature, 'hex')
        const decoratedSignature = xdr.DecoratedSignature.fromXDR(signatureBuffer, 'hex')
        const keypair = Keypair.fromPublicKey(ws.pubkey)
        if (keypair.verify(Buffer.from(hash, 'hex'), decoratedSignature.signature())) {
            oracleRunner.addSignature(hash, xdr.DecoratedSignature.fromXDR(signatureBuffer, 'raw'))
        }
    }
}

module.exports = SignaturesHandler