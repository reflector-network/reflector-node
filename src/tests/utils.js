const {exec} = require('child_process')
const {TransactionBuilder, Operation} = require('soroban-client')
const Asset = require('../models/assets/asset')
const {getMajority} = require('../utils/majority-helper')
const constants = require('./constants')

const pathToContractProject = '../../reflector-contract/price-oracle'
const pathToContractWasm = '../../reflector-contract/target/wasm32-unknown-unknown/release/reflector_oracle.wasm'

async function runCommand(command) {
    return await new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
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
    const {baseAsset, decimals, timeframe} = constants
    const {code} = new Asset(baseAsset.type, baseAsset.code, constants.network)
    const command = `cd "${pathToContractProject}" && build-wasm.sh --base_asset_type 0 --base ${code} --decimals ${decimals} --resolution ${timeframe}`
    await runCommand(command)

    const optimizeCommand = `soroban contract optimize --wasm "${pathToContractWasm}" --wasm-out "${pathToContractWasm}"`
    await runCommand(optimizeCommand)
}

async function deployContract(admin) {
    const command = `soroban contract deploy --wasm "${pathToContractWasm}" --source ${admin} --rpc-url ${constants.rpcUrl} --network-passphrase "${constants.network}"`
    return await runCommand(command)
}


function generateSingleConfig(admin, oracleId, nodes, wsStartPort, hasConnectionUrls, dbPass = null) {
    return {
        contractSettings: {
            admin,
            oracleId,
            baseAsset: constants.baseAsset,
            decimals: constants.decimals,
            horizon: constants.rpcUrl,
            network: constants.network,
            nodes,
            assets: constants.assets.slice(0, 2),
            timeframe: constants.timeframe,
            period: constants.period,
            fee: constants.fee,
            pendingUpdate: null
        },
        nodes: nodes.reduce((addresses, pubkey, index) => {
            addresses.push({
                pubkey,
                url: hasConnectionUrls ? `ws://host.docker.internal:${wsStartPort + (index * 100)}` : null
            })
            return addresses
        }, []),
        handshakeTimeout: 0,
        dbConnectionString: dbPass ? `postgres://stellar:${dbPass}@localhost:5432/core` : null,
        dbSyncDelay: 15
    }
}

/**
 *@param {Server} server
 *@param {string} admin
 */
async function createAccount(server, admin) {
    return await server.requestAirdrop(admin, 'https://friendbot-futurenet.stellar.org')
}

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
    let txBuilder = new TransactionBuilder(account, {fee: 100, networkPassphrase: constants.network})
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
    generateSingleConfig,
    updateAdminToMultiSigAccount
}