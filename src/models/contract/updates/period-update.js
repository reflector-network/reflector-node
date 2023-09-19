const UpdateBase = require('./update-base')
const UpdateType = require('./update-type')

class PeriodUpdate extends UpdateBase {
    /**
     * @param {BigInt} timestamp - pending update timestamp
     * @param {BigInt} period - pending update period
     */
    constructor(timestamp, period) {
        super(UpdateType.PERIOD, timestamp)
        if (!period)
            throw new Error('period is required')
        this.period = period
    }

    toPlainObject() {
        return {
            ...super.toPlainObject(),
            period: this.period
        }
    }
}

module.exports = PeriodUpdate