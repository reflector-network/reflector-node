const {AssetType, Asset} = require('@reflector/reflector-shared')

const defaultDecimals = 14


const baseExchangesAsset = new Asset(AssetType.OTHER, 'USD')
const baseStellarAsset = new Asset(AssetType.STELLAR, 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')

const defaultBaseAssets = new Map(Object.entries({
    exchanges: baseExchangesAsset,
    pubnet: baseStellarAsset,
    testnet: baseStellarAsset,
    forex: baseExchangesAsset
}))

module.exports = {
    defaultDecimals,
    defaultBaseAssets
}