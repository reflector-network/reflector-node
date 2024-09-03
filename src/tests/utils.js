const {exec} = require('child_process')
const {TransactionBuilder, Operation} = require('@stellar/stellar-sdk')
const {getMajority} = require('@reflector/reflector-shared')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const constants = require('./constants')

const pathToOracleContractWasm = './tests/reflector-oracle.wasm'
const pathToSubscriptionsContractWasm = './tests/reflector_subscriptions.wasm'

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

async function deployContract(admin, contractType) {
    let pathToContractWasm = pathToOracleContractWasm
    if (contractType === ContractTypes.SUBSCRIPTIONS)
        pathToContractWasm = pathToSubscriptionsContractWasm
    const command = `stellar contract deploy --wasm "${pathToContractWasm}" --source ${admin} --rpc-url ${constants.rpcUrl} --network-passphrase "${constants.network}" --fee 100000000`
    console.log(command)
    return await runCommand(command)
}

async function generateAssetContract(asset, admin) {
    const command = `stellar contract asset deploy --asset ${asset} --source ${admin} --rpc-url ${constants.rpcUrl} --network-passphrase "${constants.network}" --fee 1000000000`
    return await runCommand(command)
}

async function mint(server, asset, destination, amount, account, signer) {
    let txBuilder = new TransactionBuilder(account, {fee: 1000000, networkPassphrase: constants.network})
    txBuilder = txBuilder
        .setTimeout(30000)
        .addOperation(
            Operation.payment({
                destination,
                asset,
                amount
            })
        )

    const tx = txBuilder.build()

    tx.sign(signer)

    await sendTransaction(server, tx)
}

function generateAppConfig(secret, dataSources) {
    return {
        handshakeTimeout: 0,
        secret,
        dataSources,
        orchestratorUrl: 'http://192.168.0.137:12274',
        rsaKey: constants.rsaKeys.privateKey,
        trace: true,
        gateways: ['http://192.168.0.137:8081']
    }
}

/**
 * @param {{admin: string, contractId: string, contractType: string, dataSource: string, token: string}} configData
 * @returns {Object}
 */
function generateContractConfig(configData) {
    const {admin, contractId, contractType, dataSource, token} = configData
    if (contractType === ContractTypes.ORACLE) {
        return generateOracleContractConfig(admin, contractId, dataSource)
    } else if (contractType === ContractTypes.SUBSCRIPTIONS) {
        return generateSubscriptionsContractConfig(admin, contractId, token)
    }
}

function generateOracleContractConfig(admin, oracleId, dataSource) {
    const assets = {}
    switch (dataSource.name) {
        case 'exchanges':
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
        assets: assets.assets,//.slice(0, 2),
        timeframe: constants.timeframe,
        period: constants.period,
        fee: constants.fee,
        dataSource: dataSource.name
    }
}

function generateSubscriptionsContractConfig(admin, contractId, token) {
    return {
        admin,
        contractId,
        type: ContractTypes.SUBSCRIPTIONS,
        baseFee: 100,
        fee: constants.fee,
        token
    }
}

function generateConfig(systemAccount, contractConfigs, nodes, wasmHash, minDate, network, wsStartPort) {
    const nodeAddresses = {}
    for (let i = 0; i < nodes.length; i++) {
        const pubkey = nodes[i]
        nodeAddresses[pubkey] = {
            pubkey,
            url: `ws://192.168.0.137:${wsStartPort + (i * 100)}`,
            domain: `node${i}.com`
        }
    }

    return {
        decimals: 14,
        baseAssets: {
            exchanges: {
                type: 2,
                code: 'USD'
            }
        },
        systemAccount,
        contracts: contractConfigs,
        wasmHash,
        network,
        minDate,
        nodes: nodeAddresses
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
    deployContract,
    createAccount,
    runCommand,
    generateAppConfig,
    generateConfig,
    generateContractConfig,
    updateAdminToMultiSigAccount,
    generateAssetContract,
    mint
}