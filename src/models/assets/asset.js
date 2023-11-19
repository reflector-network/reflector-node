const {StrKey, Asset: StellarAsset} = require('soroban-client')
const {encodeAssetContractId} = require('../../utils/contractId-helper')
const AssetType = require('./asset-type')

const assetTypeValues = Object.values(AssetType)

class Asset {

    /**
     * @param {number} type - asset type (stellar or generic)
     * @param {string} code - asset code contract id or generic code
     * @param {string} networkPassphrase - network passphrase
     */
    constructor(type, code, networkPassphrase) {
        if (!type || !code)
            throw new Error('Asset type and code must be defined')

        if (!assetTypeValues.includes(type))
            throw new Error(`Asset type must be one of ${assetTypeValues.join(', ')}`)

        if (type === AssetType.STELLAR) {
            if (code !== 'XLM') {
                const [assetCode, issuer] = code.split(':')
                if (!assetCode || !issuer)
                    throw new Error('Asset code and issuer must be defined')
                if (assetCode.length > 12)
                    new Error('Asset code must be 12 characters or less')
                if (!StrKey.isValidEd25519PublicKey(issuer))
                    new Error('Asset issuer must be a valid ed25519 public key')
                this.__stellarAsset = new StellarAsset(assetCode, issuer)
            } else {
                this.__stellarAsset = StellarAsset.native()
            }
            this.code = encodeAssetContractId(this.__stellarAsset, networkPassphrase)
        } else if (type === AssetType.GENERIC) {
            if (code.length > 32)
                new Error('Asset code must be 32 characters or less')
            this.code = code
        }
        this.type = type
    }

    /**
     * @type {number} - asset type (stellar or generic)
     */
    type

    /**
     * @type {string} - asset code
     */
    code

    toString() {
        return `${this.type}:${this.code}`
    }

    getStellarAsset() {
        if (this.type !== AssetType.STELLAR)
            throw new Error('Asset is not a stellar asset')
        return this.__stellarAsset
    }

    toPlainObject() {
        let code = this.code
        if (this.type === AssetType.STELLAR)
            if (this.__stellarAsset.isNative())
                code = 'XLM'
            else
                code = `${this.__stellarAsset.code}:${this.__stellarAsset.issuer}`
        return {
            type: this.type,
            code
        }
    }
}

module.exports = Asset