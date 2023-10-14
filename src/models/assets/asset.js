const {Asset: StellarAsset, StrKey} = require('soroban-client')
const {isValidContractId, encodeAssetContractId} = require('../../utils/contractId-helper')
const AssetType = require('./asset-type')

const assetTypeValues = Object.values(AssetType)

class Asset {

    /**
     * @param {number} type - asset type (stellar or generic)
     * @param {string} code - asset code contract id or generic code
     */
    constructor(type, code) {
        if (!type || !code)
            throw new Error('Asset type and code must be defined')

        if (!assetTypeValues.includes(type))
            throw new Error(`Asset type must be one of ${assetTypeValues.join(', ')}`)

        switch (type) {
            case AssetType.STELLAR: {
                const splittedCode = code.split(':')
                if (splittedCode.length === 2) {
                    const [assetCode, issuer] = splittedCode
                    if (!assetCode || !issuer)
                        throw new Error('Asset code and issuer must be defined')
                    if (!StrKey.isValidEd25519PublicKey(issuer))
                        new Error('Asset issuer must be a valid ed25519 public key')
                    this.__stellarAsset = new StellarAsset(assetCode, issuer)
                } else if (code === 'XLM') {
                    this.__stellarAsset = StellarAsset.native()
                } else {
                    this.isContractId = isValidContractId(code)
                    if (!this.isContractId)
                        new Error(`Asset code ${code} is invalid`)
                }
            }
                break
            case AssetType.GENERIC:
                if (code.length > 32)
                    new Error('Asset code must be 32 characters or less')
                break
            default:
                throw new Error(`Asset type ${type} is not supported`)
        }
        this.code = code
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

    toOracleContractAsset(network) {
        if (!network)
            throw new Error('Network passphrase must be defined')
        let code = this.code
        if (this.type === AssetType.STELLAR)
            if (this.isContractId)
                code = this.code
            else {
                code = encodeAssetContractId(this.__stellarAsset, network)
            }
        return {
            type: this.type,
            code
        }
    }

    toPlainObject() {
        return {
            type: this.type,
            code: this.code
        }
    }
}

module.exports = Asset