const rpcUrl = 'https://soroban-testnet.stellar.org'//'https://rpc-futurenet.stellar.org'
const network = 'Test SDF Network ; September 2015'//'Test SDF Future Network ; October 2022'


const baseStellarPubnetAsset = {type: 1, code: 'X:G...W'}

const stellarPubnetAssets = [
    {type: 1, code: 'A:G...W'},
    {type: 1, code: 'B:G...W'},
    {type: 1, code: 'C:G...W'},
    {type: 1, code: 'D:G...W'},
    {type: 1, code: 'E:G...W'},
    {type: 1, code: 'F:G...W'}
]

const baseStellarTestnetAsset = {type: 1, code: 'X:G...W'}

const stellarTestnetAssets = [
    {type: 1, code: 'A:G...W'},
    {type: 1, code: 'B:G...W'},
    {type: 1, code: 'C:G...W'},
    {type: 1, code: 'D:G...W'},
    {type: 1, code: 'E:G...W'},
    {type: 1, code: 'F:G...W'}
]

const genericAssets = [
    {type: 2, code: 'BTC'},
    {type: 2, code: 'ETH'},
    {type: 2, code: 'USDT'}
]

const baseGenericAsset = {type: 2, code: 'USD'}

const sources = {
    coinmarketcap: {
        type: 'api',
        secret: '********-****-****-****-***********',
        name: 'coinmarketcap'
    },
    pubnet: {
        dbConnection: 'postgres://stellar:pass@127.0.0.1:5432/stellar-pubnet-core',
        horizonUrls: ['https://soroban-testnet.stellar.org'],
        type: 'db',
        name: 'pubnet'
    },
    testnet: {
        dbConnection: 'postgres://stellar:pass@127.0.0.1:5432/stellar-testnet-core',
        horizonUrls: ['https://bad.rpc.org', 'https://soroban-testnet.stellar.org'],
        type: 'db',
        name: 'testnet'
    }
}

function getDataSources() {
    return structuredClone(sources)
}

module.exports = {
    rpcUrl,
    network,
    baseStellarPubnetAsset,
    stellarPubnetAssets,
    baseStellarTestnetAsset,
    stellarTestnetAssets,
    baseGenericAsset,
    genericAssets,
    decimals: 14,
    timeframe: 300000,
    period: 86400000,
    fee: 10000000,
    wasmHash: '551723e0178208dd25c950bf78ab5618d47257a594654bbcaaf6cec8dc8c240c',
    minDate: 0,
    sources,
    getDataSources
}