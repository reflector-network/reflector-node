const {ConfigEnvelope} = require('@reflector/reflector-shared')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const logger = require('../../logger')
const nonceManager = require('../nonce-manager')
const MessageTypes = require('./message-types')
const BaseHandler = require('./base-handler')


/**
 * @param {ConfigEnvelope} configEnvelope
 * @param {boolean} isCurrentConfig
 */
function isConfigVerified(configEnvelope, isCurrentConfig = false) {
    if (!configEnvelope.config.isValid) {
        logger.error(`Current config is not valid. Issues:\n ${configEnvelope.config.issuesString}`)
    }
    const {settingsManager} = container
    const currentNodeSignature = configEnvelope.signatures.find(s => s.pubkey === settingsManager.appConfig.publicKey)
    if (!currentNodeSignature) {
        return false
    }
    const {nonce, signature} = currentNodeSignature
    const currentNonce = nonceManager.getNonce(MessageTypes.CONFIG)
    if (!(nonce > currentNonce //replayed
        || (isCurrentConfig && configEnvelope.config.getHash() === settingsManager.pendingConfig?.config.getHash()) //pending config applied already
    )) {
        return false
    }
    const payload = configEnvelope.config.getSignaturePayloadHash(settingsManager.appConfig.publicKey, nonce)
    if (!settingsManager.appConfig.keypair.verify(Buffer.from(payload, 'hex'), Buffer.from(signature, 'hex'))) {
        return false
    }
    nonceManager.setNonce(MessageTypes.CONFIG, nonce)
    return true
}

class ConfigHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    allowAnonymous = true

    handle(_, message) {
        if (!message.data)
            throw new Error('Data is required')
        const {currentConfig, pendingConfig} = message.data
        if (!currentConfig)
            return

        const {settingsManager} = container

        const newCurrentConfig = new ConfigEnvelope(currentConfig)
        if (isConfigVerified(newCurrentConfig, true)) {
            if (!newCurrentConfig.config.equals(settingsManager.config))
                settingsManager.setConfig(newCurrentConfig.config)
        } else {
            logger.info('Current config is not verified')
        }

        if (pendingConfig) {
            const newPendingConfig = new ConfigEnvelope(pendingConfig)
            if (isConfigVerified(newPendingConfig)) {
                if (!newPendingConfig.config.equals(settingsManager.pendingConfig?.config))
                    settingsManager.setPendingConfig(newPendingConfig)
            } else {
                logger.info('Pending config is not verified')
            }
        }
    }
}

module.exports = ConfigHandler