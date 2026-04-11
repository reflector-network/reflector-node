const fs = require('fs')
const path = require('path')
const {rpc, Keypair, Asset, Networks} = require('@stellar/stellar-sdk')
const {ContractTypes, getMajority, encodeAssetContractId} = require('@reflector/reflector-shared')
const {OracleClient} = require('@reflector/oracle-client')
const {Server} = require('@stellar/stellar-sdk/rpc')
const {generateRSAKeyPair} = require('../../src/utils/crypto-helper')
const {submitTransaction} = require('../../src/utils')
const {
    deployContract,
    createAccount,
    updateAdminToMultiSigAccount,
    generateContractConfig,
    runCommand,
    generateAppConfig,
    generateConfig,
    generateAssetContract,
    mint,
    getAccountInfo,
    addTrust,
    generateAccount,
    getAccountBalance,
    sendTransaction
} = require('./utils')
const constants = require('./constants')

const configsPath = path.join(__dirname, 'clusterData')
const tokenData = null
let rsa = null

function getNodeDirName(nodeNumber) {
    return path.join(configsPath, `node${nodeNumber}`)
}

function getReflectorHomeDirName(nodeNumber) {
    return path.join(getNodeDirName(nodeNumber), 'reflector-home')
}

function getNodesCount() {
    return fs.readdirSync(configsPath).filter(f => f.startsWith('node')).length
}

const initDAOAmount = '100000000000'

const contractConfigs = [
    {dataSource: constants.sources.pubnet},
    {dataSource: constants.sources.exchanges},
    {dataSource: constants.sources.forex}
]

const nodeConfigs = [
    {
        isInitNode: true,
        secret: 'SCGO5GR4ZDAXU7BECOIFRO5J3STD2HQECPG4X3XQ4K75VZ64WOFVLQHR',
        pubkey: 'GC5YHXAY56CXQIWCDUXL62AOZNDSW4BLFSVPFPXW5UN4CC2ZZSRLH5KV'
    },
    {
        isInitNode: true,
        secret: 'SDMHSB2JYLSEMHCX6ZZX7X42YHOZSNNK3JOLAOQE7ORC63IJHWDIBCJ4',
        pubkey: 'GD3CE7O6V77SM7W3UEXNQKG4UNJ6RKHAD2DJ4QEXOOSFXWBNL2CI6ODQ'
    },
    {
        isInitNode: true,
        secret: 'SB5KAGPBW3AIBUYGYQSMPKSGLLZSKJNRPLFQF4CDGKNKTZQ6XZJTWASO',
        pubkey: 'GBQPZIGCRQZ3L6A5WGIK6YPZ7X4FMUJAWL44M7OY2Q63TPKANEWT5MMA'
    }
]

function genearateKeypairData() {
    const keypair = Keypair.random()
    return {
        pubkey: keypair.publicKey(),
        secret: keypair.secret()
    }
}

function generateClusterConfigData() {

    const clusterConfig = {
        contracts: [
            {type: ContractTypes.SUBSCRIPTIONS, admin: genearateKeypairData(), salt: 'subscriptions'},
            {type: ContractTypes.DAO, admin: genearateKeypairData(), salt: 'dao'},
            ...contractConfigs.map(c => ({
                type: ContractTypes.ORACLE,
                admin: genearateKeypairData(),
                dataSource: c.dataSource.name,
                salt: c.dataSource.name
            })),
            ...contractConfigs.map(c => ({
                type: ContractTypes.ORACLE_BEAM,
                admin: genearateKeypairData(),
                dataSource: c.dataSource.name,
                salt: c.dataSource.name + 'beam'
            }))
        ],
        deployer: genearateKeypairData(),
        nodes: nodeConfigs,
        sysAccount: genearateKeypairData(),
        tokenIssuer: genearateKeypairData(),
        token: 'XRF'
    }

    return clusterConfig
}

async function closeEndRemoveIfExist(name) {
    const nodeExists = await runCommand(`docker ps -aq --filter name=${name}`)
    if (nodeExists) {
        const isRunning = await runCommand(`docker ps -q --filter name=${name}`)
        if (isRunning) {
            await runCommand(`docker stop ${name}`)
        }
        await runCommand(`docker rm ${name}`)
    }
}

/**
 * @param {rpc.Server} server
 * @param {KeypairData} deployer
 * @param {KeypairData[]} nodes
 * @param {{salt: string, type: string, admin: KeypairData, dataSource: string}} contractConfig
 * @param {{secret: string, pubkey: string, symbol: string, tokenId: string}} token
 * @param {string} network
 */
async function generateNewContract(server, deployer, nodes, contractConfig, token, network) {
    const contractId = await deployContract(server, deployer.secret, contractConfig.type, contractConfig.salt, network)
    if (!contractId) {
        throw new Error('Contract was not deployed')
    }

    if (contractConfig.type === ContractTypes.DAO) {
        const tokenKeypair = Keypair.fromSecret(token.secret)

        const asset = new Asset(token.symbol, token.pubkey)

        let account = await getAccountInfo(server, contractConfig.admin.pubkey)
        await addTrust(server, asset, account, nodes.slice(0, getMajority(nodes.length)).map(n => Keypair.fromSecret(n.secret)), network)

        account = await getAccountInfo(server, token.pubkey)
        await mint(server, asset, contractConfig.admin.pubkey, initDAOAmount, account, tokenKeypair, network)
    }

    const contractConfigData = {
        contractId,
        contractType: contractConfig.type,
        dataSource: contractConfig.dataSource,
        admin: contractConfig.admin.pubkey,
        token: token.tokenId,
        initAmount: initDAOAmount,
        developer: nodes[0].pubkey
    }

    const config = generateContractConfig(contractConfigData)
    return config
}


async function accountExists(server, publicKey) {
    try {
        const account = await getAccountInfo(server, publicKey)
        return !!account
    } catch (e) {
        return false
    }
}

/**
 * @param {ClusterConfig} clusterConfig
 * @param {string} network
 */
async function ensureClusterDataReady(clusterConfig, network) {
    const server = new rpc.Server(constants.networks[network].rpcUrl, {allowHttp: true})
    //temporary fix. need to find way to fetch balance from rpc
    let deployerBalance = 0
    if (!await accountExists(server, clusterConfig.deployer.pubkey)) {
        await generateAccount(clusterConfig.deployer.pubkey, network)
        deployerBalance = 10000
    }

    const createIfNotExists = async (pubKey, updateToMultisigKeypair) => {
        if (await accountExists(server, pubKey))
            return true
        if (deployerBalance < 2000) {
            await generateAccount(clusterConfig.deployer.pubkey, network)
            deployerBalance = 10000
        }
        await createAccount(server, clusterConfig.deployer.secret, pubKey, network)
        deployerBalance -= 1000
        if (updateToMultisigKeypair)
            await updateAdminToMultiSigAccount(server, updateToMultisigKeypair, clusterConfig.nodes.map(n => n.pubkey), network)
    }

    const multisigAccounts = [clusterConfig.sysAccount, ...clusterConfig.contracts.map(c => c.admin)]
    for (const account of multisigAccounts) {
        const accountKeypair = Keypair.fromSecret(account.secret)
        await createIfNotExists(accountKeypair.publicKey(), accountKeypair)
    }

    await createIfNotExists(clusterConfig.deployer.pubkey)
    await createIfNotExists(clusterConfig.tokenIssuer.pubkey)
}

/**
 * @param {ClusterConfig} clusterConfig
 * @param {string} network
 */
async function generateNewCluster(clusterConfig, network) {
    const server = new rpc.Server(constants.networks[network].rpcUrl, {allowHttp: true})

    const tokenData = await ensureTokenData(server, clusterConfig.tokenIssuer, clusterConfig.token, network)
    await ensureRSAKeys()

    const contracts = {}
    for (const c of clusterConfig.contracts) {
        const config = await generateNewContract(
            server,
            clusterConfig.deployer,
            clusterConfig.nodes,
            c,
            tokenData,
            network
        )
        contracts[config.contractId] = config
    }

    const config = generateConfig(clusterConfig.sysAccount.pubkey, contracts, clusterConfig.nodes.map(n => n.pubkey), constants.wasmHash, constants.minDate, network, 30347, rsa.privateKey)
    fs.mkdirSync(configsPath, {recursive: true})
    const configPath = path.join(configsPath, '.config.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {encoding: 'utf-8'})

    for (let i = 0; i < clusterConfig.nodes.length; i++) {
        const nodeConfig = clusterConfig.nodes[i]
        const appConfig = generateAppConfig(nodeConfig.secret, constants.getDataSources(), i)
        const nodeHomeDir = getReflectorHomeDirName(i)
        fs.mkdirSync(nodeHomeDir, {recursive: true})
        fs.writeFileSync(path.join(nodeHomeDir, 'app.config.json'), JSON.stringify(appConfig, null, 2), {encoding: 'utf-8'})
        fs.copyFileSync(configPath, path.join(nodeHomeDir, '.config.json'))
    }
}

async function startNodes(nodesCount) {
    for (let i = 0; i < nodesCount; i++) {
        try {
            console.log(`Starting node ${i}`)
            const nodeHomeDir = path.resolve(getReflectorHomeDirName(i))
            const nodeName = `node${i}`
            const port = 30347 + (i * 100)
            //closeEndRemoveIfExist(nodeName)

            const startCommand = `docker run -d -p ${port}:30347 -v "${nodeHomeDir}:/reflector-node/app/home" --restart=unless-stopped --name=${nodeName} reflector-node-dev`//`reflectornet/reflector-node:v0.12.1`//

            console.log(startCommand)
            await runCommand(startCommand)
        } catch (e) {
            console.error(e)
        }
    }
}

async function ensureTokenData(server, issuer, tokenSymbol, network) {
    const tokenDataFile = path.join(__dirname, 'token-data.json')
    if (!fs.existsSync(tokenDataFile))
        fs.writeFileSync(tokenDataFile, JSON.stringify({}, null, 2), {encoding: 'utf-8'})

    const tokenData = JSON.parse(fs.readFileSync(tokenDataFile, {encoding: 'utf-8'}))

    const tokenAdmin = Keypair.fromSecret(issuer.secret)
    const token = `${tokenSymbol}:${tokenAdmin.publicKey()}`
    if (tokenData[token])
        return tokenData[token]

    const tokenContract = await generateAssetContract(server, token, tokenAdmin.secret(), network)
    tokenData[token] = {secret: tokenAdmin.secret(), pubkey: tokenAdmin.publicKey(), tokenId: tokenContract, symbol: tokenSymbol}
    fs.writeFileSync(tokenDataFile, JSON.stringify(tokenData, null, 2), {encoding: 'utf-8'})

    return tokenData[token]
}

async function ensureRSAKeys() {
    const rsaDataFile = path.join(__dirname, 'rsa.json')
    if (!fs.existsSync(rsaDataFile)) {
        const rsaKeys = await generateRSAKeyPair()
        const privateKey = Buffer.from(rsaKeys.privateKey).toString('base64')
        const pubKey = Buffer.from(rsaKeys.publicKey).toString('base64')
        rsa = {privateKey, pubKey}
        fs.writeFileSync(rsaDataFile, JSON.stringify(rsa, null, 2), {encoding: 'utf-8'})
    } else
        rsa = JSON.parse(fs.readFileSync(rsaDataFile, {encoding: 'utf-8'}))
}

/**
 * @typedef {Object} KeypairData
 * @property {string} pubkey
 * @property {string} secret
 */

/**
 * @typedef {Object} ClusterConfig
 * @property {KeypairData} deployer
 * @property {KeypairData[]} nodes
 * @property {KeypairData} sysAccount
 * @property {KeypairData} tokenIssuer
 * @property {string} token
 * @property {{salt: [string], type: string, admin: KeypairData, dataSource: string}[]} contracts
 */

/**
 * @param {ClusterConfig} clusterConfig
 */
async function run(clusterConfig, network = 'testnet') {
    if (!fs.existsSync(configsPath)) {
        if (!clusterConfig) {
            clusterConfig = generateClusterConfigData()
            console.log('<--Cluster config generated-->'.repeat(5))
            console.log(JSON.stringify(clusterConfig, null, 2))
            console.log('<--Cluster config generated-->'.repeat(5))
        }
        await ensureClusterDataReady(clusterConfig, network)
        await generateNewCluster(clusterConfig, network)
    }
    await startNodes(getNodesCount())
}


const clusterConfig = null
async function extendAssets() {
    const config = require('./clusterData/.config.json')
    const beams = Object.values(config.contracts).filter(c => c.type === 'oracle_beam' || c.type === 'oracle')//&& c.dataSource === 'pubnet')
    const getMultipleRandom = (arr, n) => {
        const shuffled = [...arr].sort(() => 0.5 - Math.random())
        return shuffled.slice(0, n)
    }
    for (const beam of beams) {
        //const oracleClient = new OracleClient(Networks.TESTNET, ["https://soroban-testnet.stellar.org"], beam.contractId)
        //const server = new Server("https://soroban-testnet.stellar.org")
        //const account = await getAccountInfo(server, config.systemAccount)
        //const update = await oracleClient.setFeeConfig(account,
        //{admin: beam.admin, feeConfig: {fee: 100n, token: "CBULLEXCJPG2734I5V62IMZSCM3GOH3L55BHKNBIDRK2QIR5YH4SN6IJ"}},
        //{
        //fee: 10000,
        //timebounds: {
        //minTime: 0,
        //maxTime: 0
        //}
        //})
        //update.sign(Keypair.fromSecret("SDIQWQIPDF4GRQVQTPIMXLCPXG6XRWL5IZMZRHYRHYMG4JBDA3E6E6WE"))

        //await sendTransaction(server, update)

        const assets = getMultipleRandom(beam.assets, Math.min(15, beam.assets.length))
        let count = 0
        for (const asset of assets) {
            let type = 'Other'
            let code = asset.code
            if (asset.type === 1) {
                type = 'Stellar'
                code = encodeAssetContractId(new Asset(...asset.code.split(':')), Networks.TESTNET)
            }
            try {
                await runCommand(`stellar contract invoke --network ${config.network} --source SB4YZ4C5ZRNARCVGGPSI7CWDTS55DCMJEHCE6WG3ORM2TDLYP35D46BK --id ${beam.contractId} --send=yes -- extend_asset_ttl --sponsor GCQ4MXBUEX77VWCH3TONZ3YRMAZOFPAAUY6V5BPD3GUK4JE6HFGRS5CV --asset "{\\"${type}\\": \\"${code}\\"}" --amount 1000`, [])
                count++
                console.log(`Asset ${asset.code} extended successfully (${count}/${beam.assets.length})`)
            } catch (e) {
                console.error(`Error extending asset ${asset.code}: ${e.message}`)
            }
        }
    }
}

//run(clusterConfig, 'testnet').catch(console.error)
extendAssets().catch(console.error)