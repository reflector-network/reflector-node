const container = require('../container')
const logger = require('../../logger')
const RunnerBase = require('./runner-base')

const timeframe = 1000 * 60 //1 minute

class PriceRunner extends RunnerBase {
    async __workerFn(timestamp) {
        const {tradesManager} = container
        logger.debug(`PriceRunner -> __workerFn -> timestamp: ${timestamp}`)
        await tradesManager.loadTradesData() //load last completed timeframe
        return false
    }

    get __timeframe() {
        return timeframe
    }

    __getNextTimestamp(currentTimestamp) {
        return currentTimestamp + timeframe //1 minute
    }

    get __delay() {
        return container.settingsManager.appConfig.dbSyncDelay
    }
}

module.exports = PriceRunner