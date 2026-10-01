const fs = require('fs')
const path = require('path')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const logger = require('../../logger')
const BaseHandler = require('./base-handler')

const tokenPattern = /^[0-9a-f]{64}$/

/**
 * Stores the Loki push token the orchestrator issues after the handshake. Promtail reads it from
 * <homeDir>/promtail/token on every push (bearer_token_file), so a rotated token needs no restart.
 */
class LogTokenHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.ORCHESTRATOR]

    allowAnonymous = true

    /**
     * @param {ChannelBase} channel - channel
     * @param {any} message - message to handle
     */
    //eslint-disable-next-line class-methods-use-this
    handle(channel, message) {
        const token = message.data?.token
        if (typeof token !== 'string' || !tokenPattern.test(token))
            throw new Error('Invalid log token')
        const dir = path.join(container.homeDir, 'promtail')
        fs.mkdirSync(dir, {recursive: true})
        const target = path.join(dir, 'token')
        const temp = `${target}.tmp`
        fs.writeFileSync(temp, token, {mode: 0o600})
        fs.renameSync(temp, target)
        logger.debug('Log token updated')
    }
}

module.exports = LogTokenHandler
