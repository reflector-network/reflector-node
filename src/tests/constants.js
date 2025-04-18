const rpcUrl = 'https://soroban-testnet.stellar.org'
const network = 'Test SDF Network ; September 2015'


const baseStellarPubnetAsset = {type: 1, code: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'}

const stellarPubnetAssets = [
    {type: 1, code: 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'},
    {type: 1, code: 'yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF'},
    {type: 1, code: 'FIDR:GBZQNUAGO4DZFWOHJ3PVXZKZ2LTSOVAMCTVM46OEMWNWTED4DFS3NAYH'},
    {type: 1, code: 'SSLX:GBHFGY3ZNEJWLNO4LBUKLYOCEK4V7ENEBJGPRHHX7JU47GWHBREH37UR'},
    {type: 1, code: 'ARST:GCSAZVWXZKWS4XS223M5F54H2B6XPIIXZZGP7KEAIU6YSL5HDRGCI3DG'},
    {type: 1, code: 'XLM'}
]

const genericAssets = [
    {type: 2, code: 'BTC'},
    {type: 2, code: 'ETH'},
    {type: 2, code: 'USDT'},
    {type: 2, code: 'XRP'}
]

const fiatAssets = [
    {type: 2, code: 'EUR'},
    {type: 2, code: 'PLN'},
    {type: 2, code: 'GBP'},
    {type: 2, code: 'JPY'},
    {type: 2, code: 'XAU'}
]

const baseGenericAsset = {type: 2, code: 'USD'}

const sources = {
    exchanges: {
        type: 'api',
        name: 'exchanges'
    },
    forex: {
        type: 'api',
        name: 'forex',
        providers: {
            'nbp': {},
            'ecb': {},
        }
    },
    pubnet: {
        sorobanRpc: ['https://soroban-testnet.stellar.org'],
        type: 'db',
        name: 'pubnet'
    },
    testnet: {
        sorobanRpc: ['https://soroban-testnet.stellar.org'],
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
    baseGenericAsset,
    fiatAssets,
    genericAssets,
    decimals: 14,
    timeframe: 300000,
    period: 86400000,
    fee: 10000000,
    wasmHash: 'df88820e231ad8f3027871e5dd3cf45491d7b7735e785731466bfc2946008608',
    minDate: 0,
    sources,
    getDataSources
}