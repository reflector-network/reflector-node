
const fs = require('fs')

let logger = null
try {
    const homeDir = './home'
    if (!fs.existsSync(homeDir))
        fs.mkdirSync(homeDir)

    logger = require('./logger')

    const container = require('./domain/container')
    const SettingsManager = require('./domain/settings-manager')
    const WsServer = require('./ws-server')
    const HandlersManager = require('./ws-server/handlers/handlers-manager')
    const StatisticsManager = require('./domain/statistics-manager')
    const OracleRunnerManager = require('./domain/transactions/oracle-runner-manager')

    logger.info('Starting reflector node')

    container.settingsManager = new SettingsManager()
    container.statisticsManager = new StatisticsManager()
    container.handlersManager = new HandlersManager()
    container.webSocketServer = new WsServer()
    container.oracleRunnerManager = new OracleRunnerManager()
    require('./app')(container)
} catch (e) {
    if (logger)
        logger.error(e)
    else
        console.error(e)
    setTimeout(() => process.exit(13), 1000)
}