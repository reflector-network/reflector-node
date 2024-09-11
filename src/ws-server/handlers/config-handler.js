const {ConfigEnvelope} = require('@reflector/reflector-shared')
const {Keypair} = require('@stellar/stellar-sdk')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const logger = require('../../logger')
const nonceManager = require('../nonce-manager')
const BaseHandler = require('./base-handler')

/**
 * @typedef {import('@reflector/reflector-shared').ConfigEnvelope} ConfigEnvelope
 */

/**
 * @param {ConfigEnvelope} configEnvelope - config envelope
 * @param {number} nonceType - nonce type
 * @returns {{verified: boolean, nonce: number}} - verification result. nonce contains new nonce. If nonce is 0, the nonce is the same as the current node nonce
 */
function verifyConfig(configEnvelope, nonceType) {
    if (!configEnvelope.config.isValid) {
        logger.error(`Current config is not valid. Issues:\n ${configEnvelope.config.issuesString}`)
        return false
    }
    const currentNonce = nonceManager.getNonce(nonceType)
    const {publicKey: currentPubkey} = container.settingsManager.appConfig
    const result = {verified: false, nonce: null}
    for (const signatureObject of configEnvelope.signatures) {
        const {nonce, pubkey, signature} = signatureObject
        const payload = configEnvelope.config.getSignaturePayloadHash(pubkey, nonce)

        if (!Keypair.fromPublicKey(pubkey).verify(Buffer.from(payload, 'hex'), Buffer.from(signature, 'hex')))
            return result

        if (pubkey === currentPubkey) {
            if (nonce < currentNonce) {
                logger.debug('Signature for current node is outdated')
                return result
            }
            result.nonce = nonce > currentNonce ? nonce : currentNonce
        }
    }
    result.verified = result.nonce !== null
    return result
}

class ConfigHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    async handle(_, message) {
        if (!message.data)
            throw new Error('Data is required')
        const {currentConfig, pendingConfig} = message.data
        if (!currentConfig) //if no current config, then no updates
            return

        const {settingsManager} = container

        const newCurrentConfig = new ConfigEnvelope(currentConfig)
        const configVerificationResult = verifyConfig(newCurrentConfig, nonceManager.nonceTypes.CONFIG)
        if (configVerificationResult.verified) {
            await settingsManager.setConfig(newCurrentConfig.config, configVerificationResult.nonce)
        } else {
            logger.debug('Current config is not verified')
        }

        if (pendingConfig) {
            const newPendingConfig = new ConfigEnvelope(pendingConfig)
            const pendingConfigVerificationResult = verifyConfig(newPendingConfig, nonceManager.nonceTypes.PENDING_CONFIG)
            if (pendingConfigVerificationResult.verified) {
                settingsManager.setPendingConfig(newPendingConfig, pendingConfigVerificationResult.nonce)
            } else {
                logger.debug('Pending config is not verified')
            }
        } else {
            settingsManager.clearPendingConfig()
        }
    }
}

module.exports = ConfigHandler