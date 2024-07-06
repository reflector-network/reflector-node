const container = require('../container')
const logger = require('../../logger')
const priceManager = require('../price-manager')
const RunnerBase = require('./runner-base')

const timeframe = 1000 * 60 //1 minute

class PriceRunner extends RunnerBase {
    async __workerFn(timestamp) {
        await priceManager.loadTradesData(timestamp)
        logger.debug(`PriceRunner -> __workerFn -> timestamp: ${timestamp}`)
    }

    get __timeframe() {
        return timeframe
    }

    __getNextTimestamp(currentTimestamp) {
        return currentTimestamp + timeframe //1 minute
    }

    get __dbSyncDelay() {
        return (container.settingsManager.appConfig.dbSyncDelay || 15) * 1000
    }
}

module.exports = PriceRunner