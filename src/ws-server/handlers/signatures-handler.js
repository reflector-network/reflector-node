const {xdr, Keypair} = require('@stellar/stellar-sdk')
const ChannelTypes = require('../channels/channel-types')
const runnerManager = require('../../domain/runners/runner-manager')
const logger = require('../../logger')
const BaseHandler = require('./base-handler')

const txHashPattern = /^[0-9a-f]{64}$/

class SignaturesHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.OUTGOING, ChannelTypes.INCOMING]

    allowAnonymous = false

    handle(ws, message) {
        const {signature, hash, contractId} = message.data || {}
        if (typeof signature !== 'string' || typeof hash !== 'string' || !txHashPattern.test(hash))
            return
        //a peer may gossip about a contract this node does not run for a moment after a config change; that is not an error
        if (contractId && !runnerManager.has(contractId))
            return
        const runner = contractId ? runnerManager.get(contractId) : runnerManager.updatesRunner
        if (!runner)
            return
        let decoratedSignature = null
        try {
            decoratedSignature = xdr.DecoratedSignature.fromXdr(Buffer.from(signature, 'hex'))
        } catch (err) {
            logger.debug({msg: 'Malformed signature payload.', node: ws.pubkey})
            return
        }
        const keypair = Keypair.fromPublicKey(ws.pubkey)
        //the frame must carry the sending peer's own hint, so one peer cannot relay another node's signature.
        //compare the raw bytes: xdr wrapper equality also demands the same constructor, so a hint minted by a second
        //copy of the sdk in the same process would be refused despite identical bytes
        if (Buffer.compare(Buffer.from(decoratedSignature.hint.toXDR()), Buffer.from(keypair.signatureHint())) !== 0) {
            logger.debug({msg: 'Signature hint does not match the sending peer.', node: ws.pubkey})
            return
        }
        if (!keypair.verify(Buffer.from(hash, 'hex'), decoratedSignature.signature))
            return
        runner.addSignature(hash, decoratedSignature, ws.pubkey)
    }
}

module.exports = SignaturesHandler
