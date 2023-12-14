const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')
const { Config, ConfigEnvelope, } = require('@reflector/reflector-shared')
const logger = require('../../logger')

class ConfigHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.ORCHESTRATOR

    async handle(_, message) {
        if (!message.data)
            throw new Error('Data is required')
        const { currentConfig, pendingConfig } = message.data
        if (!currentConfig)
            throw new Error('Current config is required')
        if (!pendingConfig)
            throw new Error('Pending config is required')
        const { settingsManager } = container

        const newCurrentConfig = new ConfigEnvelope(currentConfig)
        validateConfig(newCurrentConfig)
        if (!newCurrentConfig.config.equals(settingsManager.config))
            settingsManager.setConfig(newCurrentConfig)

        if (pendingConfig) {
            const newPendingConfig = new ConfigEnvelope(pendingConfig)
            validateConfig(newPendingConfig)
            if (!newPendingConfig.config.equals(settingsManager.pendingConfig?.config))
                settingsManager.setPendingConfig(newPendingConfig)
        }
    }

    /**
     * @param {ConfigEnvelope} config 
     */
    validateConfig(configEnvelope) {
        if (!configEnvelope.config.isValid) {
            logger.error(`Current config is not valid. Issues:\n ${configEnvelope.config.issuesString}`)
        }
        const currentNodeSignature = configEnvelope.signatures.find(s => s.pubkey === settingsManager.appConfig.publicKey)
        if (!currentNodeSignature)
            throw new Error('Current node signature is required')
        const { nonce, signature } = currentNodeSignature
        const payload = configEnvelope.config.getSignaturePayloadHash(settingsManager.appConfig.publicKey, nonce)
        if (!settingsManager.appConfig.keypair.verify(payload, signature))
            throw new Error('Invalid signature')
    }
}

module.exports = ConfigHandler