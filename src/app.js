const {init: initDbConnection} = require('@reflector/reflector-db-connector')
const logger = require('./logger')
const SettingsManager = require('./domain/settings-manager')

/**
 * @typedef {import('./domain/container')} Container
 */


/**
 * @param {Container} container - config object
 * @returns {Promise<void>}
 */
async function startNode(container) {

    //if dbConnectionString is not defined, then we are running in docker and dbPassword is defined
    const connectionString = container.settingsManager.config.dbConnectionString
    || `postgres://stellar:${encodeURIComponent(container.settingsManager.config.dockerDbPassword)}@localhost:5432/core`
    initDbConnection({connectionString})

    container.nodesManager.start()

    await container.transactionsManager.start()

    container.webSocketServer.start()
}

/**
 * @param {Container} container - config object
 */
function stopNode(container) {
    container.webSocketServer.shutdown(true)

    container.nodesManager.stop()

    container.transactionsManager.stop()
}

/**
 * @param {Container} container - config object
 * @returns {Promise<{shutdown: function}>}
 */
async function init(container) {

    function shutdown(code = 0) {

        logger.info('Received kill signal, code = ' + code)

        logger.info('Closing ws server.')

        container.nodesManager.stop()

        container.httpServer.close()

        container.webSocketServer.shutdown(true)

        process.exit(code)

    }
    try {
        process.on('unhandledRejection', (reason, p) => {
            logger.error('Unhandled Rejection at: Promise')
            logger.error(reason)
        })

        if (!container)
            throw new Error('container is required')
        process.on('SIGINT', () => {
            shutdown()
        })

        process.on('SIGTERM', () => {
            shutdown()
        })

        container.httpServer.start()

        container.app = {shutdown}

        if (container.settingsManager.config.isValid) {
            await startNode(container)
        } else {
            logger.warn('Node is not configured. Waiting for configuration update.')
            logger.warn(`Current config issues:\n ${container.settingsManager.config.issuesString}`)
            container.settingsManager.on(SettingsManager.EVENTS.CONTRACT_SETTINGS_UPDATED, async () => {
                try {
                    if (container.nodesManager.isRunning)
                        await stopNode(container)
                    if (container.settingsManager.config.isValid) {
                        await startNode(container)
                    }
                } catch (e) {
                    logger.error(e)
                    shutdown(13)
                }
            })
        }

        return container.app
    } catch (e) {
        logger.error(e)
        shutdown(13)
    }
}

module.exports = init