const container = require('../container')
const RunnerBase = require('./runner-base')

const timeframe = 1000 * 60 //1 minute

class PriceRunner extends RunnerBase {
    async __workerFn(timestamp) {
        const {tradesManager} = container
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

    get delay() {
        return this.__delay
    }
}

module.exports = PriceRunner