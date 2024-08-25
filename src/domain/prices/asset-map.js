/**
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

const {AssetType} = require('@reflector/reflector-shared')

class AssetsMap {
    /**
     * @param {string} source - source
     * @param {Asset} baseAsset - base asset
     */
    constructor(source, baseAsset) {
        if (!source)
            throw new Error('Source is required')
        if (!baseAsset)
            throw new Error('Base asset is required')
        this.source = source
        this.baseAsset = baseAsset
    }

    /**
     * @param {Asset[]} assets - assets
     */
    push(assets) {
        let lastIndex = Object.keys(this.assets).length
        for (const asset of assets) {
            if (!asset)
                continue
            if (!this.assets[asset.code]) {
                this.assets[asset.code] = {asset, index: lastIndex}
                lastIndex++
            }
        }
    }

    /**
     * @type {string}
     */
    source = null

    /**
     * @type {Asset}
     */
    baseAsset = null

    /**
     * @type {[key: string]: {asset: Asset, index: number}}
     * Asset code to index map
     */
    assets = {}
}

module.exports = AssetsMap