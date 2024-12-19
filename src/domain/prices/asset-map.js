/**
 * @typedef {import('@reflector/reflector-shared').Asset} Asset
 */

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
        this.mappedAssets = new Map()
    }

    /**
     * @param {Asset[]} assets - assets
     */
    push(assets) {
        let lastIndex = this.mappedAssets.size
        for (const asset of assets) {
            if (!asset)
                continue
            if (!this.mappedAssets.get(asset.code)) {
                this.mappedAssets.set(asset.code, {asset, index: lastIndex})
                lastIndex++
            }
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
     * @type {Map<string,{asset: Asset, index: number}>}
     * @private
     */
    mappedAssets

    /**
     * Get all mapped assets
     * @return {{asset: Asset, index: number}[]}
     */
    get assets() {
        return Array.from(this.mappedAssets.values())
    }

    /**
     * @param {string} code - asset code
     * @return {{asset: Asset, index: number}}
     */
    getAssetInfo(code) {
        return this.mappedAssets.get(code)
    }

    toPlainObject() {
        return {
            source: this.source,
            baseAsset: this.baseAsset.code,
            assets: [...this.mappedAssets.keys()]
        }
    }
}

module.exports = AssetsMap