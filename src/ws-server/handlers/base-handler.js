/*eslint-disable require-await */
/*eslint-disable no-unused-vars */
/*eslint-disable class-methods-use-this */

/**
 * @typedef {import('../channels/channel-base')} ChannelBase
 */

class BaseHandler {
    /**
     * @type {number}
     * @readonly
     */
    allowedChannelTypes = 0

    /**
     * @type {boolean}
     * @readonly
     */
    allowAnonymous = false

    /**
     * @param {ChannelBase} channel - channel type
     * @param {any} message - message to handle
     * @returns {Promise<any>} - response message
     */

    async handle(channel, message) {
        throw new Error('Not implemented')
    }
}

module.exports = BaseHandler