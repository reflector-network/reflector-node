/**
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

class AssetsMap {
    /**
     * @param {string} source - source
     * @param {Asset} baseAsset - base asset
     * @param {Asset[]} assets - assets
     */
    constructor(source, baseAsset, assets = []) {
        if (!source)
            throw new Error('Source is required')
        if (!baseAsset)
            throw new Error('Base asset is required')
        this.source = source
        this.baseAsset = baseAsset
        this.assets = assets
    }

    /**
     * @param {Asset[]} assets - assets
     */
    push(assets) {
        for (const asset of assets) {
            if (!asset || this.assets.findIndex(a => a.code === asset.code) !== -1)
                continue
            this.assets.push(asset)
        }
    }

    /**
     * Provider
     * @type {string}
     */
    source = null

    /**
     * Base provider asset
     * @type {Asset}
     */
    baseAsset = null

    /**
     * Asset code to index map
     * @type {Asset[]}>}
     * @private
     */
    assets

    /**
     * @param {string} code - asset code
     * @return {{asset: Asset, index: number}}
     */
    getAssetInfo(code) {
        const asset = this.assets.find(a => a.code === code)
        if (!asset)
            return undefined
        return {asset, index: this.assets.indexOf(asset)}
    }

    toPlainObject() {
        return {
            source: this.source,
            baseAsset: this.baseAsset.toPlainObject(),
            assets: this.assets.map(a => a.toPlainObject())
        }
    }
}

module.exports = AssetsMap