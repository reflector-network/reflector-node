const logger = require('./logger')

/**
 * @typedef {import('./domain/container')} Container
 */

/**
 * @param {Container} container - config object
 * @returns {Promise<{shutdown: function}>}
 */
async function init(container) {

    function shutdown(code = 0) {

        logger.info('Received kill signal, code = ' + code)

        logger.info('Closing ws server.')

        container.webSocketServer?.close()

        process.exit(code)

    }
    try {
        process.on('unhandledRejection', (reason, p) => {
            logger.error({err: reason}, 'Unhandled promise rejection')
        })

        process.on('uncaughtException', (err, origin) => {
            logger.error({err}, 'Unhandled application exception at ' + origin)
            setTimeout(() => process.exit(1), 2000)
        })

        process.on('warning', (warning) => {
            logger.warn(warning.name)
            logger.warn(warning.message)
            logger.warn(warning.stack)
        })

        if (!container)
            throw new Error('container is required')
        process.on('SIGINT', () => {
            shutdown()
        })

        process.on('SIGTERM', () => {
            shutdown()
        })


        await container.settingsManager.init()
        container.webSocketServer.init()

        container.app = {shutdown}
        return container.app
    } catch (e) {
        logger.error(e)
        //some timeout to write logs
        setTimeout(() => shutdown(13), 3000)
    }
}

module.exports = init
