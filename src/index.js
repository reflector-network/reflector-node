
const fs = require('fs')

let logger = null
try {
    let homeDir = './home'

    process.argv.forEach(value => {
        const [key, val] = value.split('=')
        if (key === 'homeDir')
            homeDir = val
    })

    if (!fs.existsSync(homeDir))
        fs.mkdirSync(homeDir)


    const container = require('./domain/container')
    container.homeDir = homeDir

    logger = require('./logger')

    const TradesManager = require('./domain/prices/trades-manager')
    const SettingsManager = require('./domain/settings-manager')
    const WsServer = require('./ws-server')
    const HandlersManager = require('./ws-server/handlers/handlers-manager')

    logger.info(`Starting reflector node v${container.version}`)

    container.settingsManager = new SettingsManager()
    container.handlersManager = new HandlersManager()
    container.webSocketServer = new WsServer()
    container.tradesManager = new TradesManager()
    require('./app')(container)
} catch (e) {
    if (logger)
        logger.error(e)
    else
        console.error(e)
    setTimeout(() => process.exit(13), 3000)
}