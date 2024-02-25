const {exec} = require('child_process')
const {TransactionBuilder, Operation} = require('@stellar/stellar-sdk')
const Client = require('@reflector/oracle-client')
const {getMajority} = require('@reflector/reflector-shared')
const constants = require('./constants')

const pathToContractProject = '../../reflector-contract'
const pathToContractWasm = '../../reflector-contract/target/wasm32-unknown-unknown/release/reflector_oracle.wasm'

async function runCommand(command, args) {
    return await new Promise((resolve, reject) => {
        exec(command, args, (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`)
                reject(error)
                return
            }
            if (stderr) {
                console.warn(`stderr: ${stderr}`)
                //reject(new Error(stderr))
                //return
            }
            resolve(stdout.trim())
        })
    })
}

async function buildContract() {
    const command = `cd "${pathToContractProject}" && cargo build --release --target wasm32-unknown-unknown`
    await runCommand(command)

    const optimizeCommand = `soroban contract optimize --wasm "${pathToContractWasm}" --wasm-out "${pathToContractWasm}"`
    await runCommand(optimizeCommand)
}

async function deployContract(admin) {
    const command = `soroban contract deploy --wasm "${pathToContractWasm}" --source ${admin} --rpc-url ${constants.rpcUrl} --network-passphrase "${constants.network}" --fee 100000000`
    console.log(command)
    return await runCommand(command)
}

function generateAppConfig(secret, dataSources) {
    return {
        handshakeTimeout: 0,
        secret,
        dataSources
    }
}

function generateContractConfig(admin, oracleId, dataSource) {
    const assets = {}
    switch (dataSource.name) {
        case 'coinmarketcap':
            assets.baseAsset = constants.baseGenericAsset
            assets.assets = constants.genericAssets
            break
        case 'pubnet':
            assets.baseAsset = constants.baseStellarPubnetAsset
            assets.assets = constants.stellarPubnetAssets
            break
        case 'testnet':
            assets.baseAsset = constants.baseStellarTestnetAsset
            assets.assets = constants.stellarTestnetAssets
            break
        default:
            throw new Error('Unknown data source')
    }
    return {
        admin,
        oracleId,
        baseAsset: assets.baseAsset,
        decimals: constants.decimals,
        assets: assets.assets,//.slice(0, 2),
        timeframe: constants.timeframe,
        period: constants.period,
        fee: constants.fee,
        dataSource: dataSource.name
    }
}

function generateConfig(systemAccount, contractConfigs, nodes, wasmHash, minDate, network, wsStartPort, hasConnectionUrls) {
    const nodeAddresses = {}
    for (let i = 0; i < nodes.length; i++) {
        const pubkey = nodes[i]
        nodeAddresses[pubkey] = {
            pubkey,
            url: `ws://localhost:${wsStartPort + (i * 100)}`,
            domain: `node${i}.com`
        }
    }

    return {
        systemAccount,
        contracts: contractConfigs,
        wasmHash,
        network,
        minDate,
        nodes: nodeAddresses
    }
}

async function bumpContract(server, keypair, oracleId) {

    const t = true
    let bump = 5_000_000
    while (t) {
        try {
            const accountInfo = await server.getAccount(keypair.publicKey())
            const client = new Client(constants.network, constants.rpcUrl, oracleId)
            const bumpTx = await client.bump(accountInfo, bump, {fee: 10000000})

            const res = await client.submitTransaction(bumpTx, [keypair.signDecorated(bumpTx.hash())])
            if (res.status !== 'SUCCESS')
                throw new Error(`Bump failed with status ${res.status}`)
            console.log(`Bumped to ${bump} ledgers.`)
            return
        } catch (e) {
            console.log(e)
            bump /= 2
            if (bump < 100_000)
                throw e
        }
    }
}

/**
 *@param {Server} server
 *@param {string} admin
 */
async function createAccount(server, admin) {
    return await server.requestAirdrop(admin, 'https://friendbot.stellar.org')
}

/**
 *@param {Server} server
 *@param {Keypair} admin
 */
async function getAccountInfo(server, publicKey) {
    const account = await server.getAccount(publicKey)
    return account
}

/**
 *@param {Server} server
 *@param {Keypair} admin
 *@param {string[]} nodesPublicKeys
 *@returns {Promise<void>}
 */
async function updateAdminToMultiSigAccount(server, admin, nodesPublicKeys) {
    const account = await getAccountInfo(server, admin.publicKey())

    const majorityCount = getMajority(nodesPublicKeys.length)
    let txBuilder = new TransactionBuilder(account, {fee: 10000000, networkPassphrase: constants.network})
    txBuilder = txBuilder
        .setTimeout(30000)
        .addOperation(
            Operation.setOptions({
                masterWeight: 0,
                lowThreshold: majorityCount,
                medThreshold: majorityCount,
                highThreshold: majorityCount
            })
        )

    for (const nodePublicKey of nodesPublicKeys) {
        txBuilder = txBuilder.addOperation(
            Operation.setOptions({
                signer: {
                    ed25519PublicKey: nodePublicKey,
                    weight: 1
                }
            })
        )
    }

    const tx = txBuilder.build()

    tx.sign(admin)

    await sendTransaction(server, tx)
}

async function sendTransaction(server, tx) {
    let result = await server.sendTransaction(tx)
    const hash = result.hash
    while (result.status === 'PENDING' || result.status === 'NOT_FOUND') {
        await new Promise(resolve => setTimeout(resolve, 1000))
        result = await server.getTransaction(hash)
    }
    if (result.status !== 'SUCCESS') {
        throw new Error(`Tx failed: ${result.status}, result: ${result.resultXdr}`)
    }
    return result
}

module.exports = {
    buildContract,
    deployContract,
    createAccount,
    runCommand,
    generateAppConfig,
    generateConfig,
    generateContractConfig,
    updateAdminToMultiSigAccount,
    bumpContract
}