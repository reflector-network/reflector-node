const UpdateBase = require('./update-base')
const UpdateType = require('./update-type')

/**
 * @typedef {import('../../assets/asset')} Asset
 */

class AssetsUpdate extends UpdateBase {
    /**
     * @param {BigInt} timestamp - pending update timestamp
     * @param {Asset[]} assets - pending update assets
     */
    constructor(timestamp, assets) {
        super(UpdateType.ASSETS, timestamp)
        if (!assets || !assets.length)
            throw new Error('assets is required')
        this.assets = assets
    }

    toPlainObject() {
        return {
            ...super.toPlainObject(),
            assets: this.assets.map(a => a.toPlainObject())
        }
    }
}

module.exports = AssetsUpdate