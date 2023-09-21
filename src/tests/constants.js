const rpcUrl = 'https://soroban-testnet.stellar.org'//'https://rpc-futurenet.stellar.org'
const network = 'Test SDF Network ; September 2015'//'Test SDF Future Network ; October 2022'
const assets = [
    {type: 1, code: 'A:G...W'},
    {type: 1, code: 'B:G...W'},
    {type: 1, code: 'C:G...W'},
    {type: 1, code: 'D:G...W'},
    {type: 1, code: 'E:G...W'},
    {type: 1, code: 'F:G...W'},
    {type: 1, code: 'G:G...W'}
]

const baseAsset = {type: 1, code: 'X:G...W'}

module.exports = {
    rpcUrl,
    network,
    assets,
    baseAsset,
    decimals: 14,
    timeframe: 120000,
    period: 120000 * 1000,
    fee: 10000000
}