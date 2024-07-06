const {xdr} = require('@stellar/stellar-sdk')
const {Keypair} = require('@stellar/stellar-sdk')
const ChannelTypes = require('../channels/channel-types')
const runnerManager = require('../../domain/runners/runner-manager')
const BaseHandler = require('./base-handler')

class SignaturesHandler extends BaseHandler {

    constructor() {
        super()
    }

    allowedChannelTypes = ChannelTypes.OUTGOING

    async handle(ws, message) {
        const {signature, hash, contractId} = message.data
        if (!(signature && hash)) {
            return
        }

        const oracleRunner = contractId ? runnerManager.get(contractId) : runnerManager.updatesRunner
        if (!oracleRunner)
            return

        const signatureBuffer = Buffer.from(signature, 'hex')
        const decoratedSignature = xdr.DecoratedSignature.fromXDR(signatureBuffer, 'hex')
        const keypair = Keypair.fromPublicKey(ws.pubkey)
        if (keypair.verify(Buffer.from(hash, 'hex'), decoratedSignature.signature())) {
            oracleRunner.addSignature(hash, xdr.DecoratedSignature.fromXDR(signatureBuffer, 'raw'), ws.pubkey)
        }
    }
}

module.exports = SignaturesHandler