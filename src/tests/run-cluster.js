const fs = require('fs')
const path = require('path')
const {rpc, Keypair, Asset} = require('@stellar/stellar-sdk')
const {ContractTypes} = require('@reflector/reflector-shared')
const {generateRSAKeyPair} = require('../utils/crypto-helper')
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
    addTrust
} = require('./utils')
const constants = require('./constants')

const configsPath = './tests/clusterData'
let tokenData = null
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
 * @param {string[]} nodes
 * @param {string} contractType
 * @param {string} dataSource
 */
async function generateNewContract(server, nodes, contractType, dataSource) {
    const admin = Keypair.random()
    await createAccount(admin.publicKey())
    console.log('Admin ' + admin.publicKey() + ' secret:' + admin.secret())
    const contractId = await deployContract(admin.secret(), contractType)
    if (!contractId) {
        throw new Error('Contract was not deployed')
    }

    if (contractType === ContractTypes.DAO) {
        const tokenKeypair = Keypair.fromSecret(tokenData.secret)

        const asset = new Asset('XRF', tokenKeypair.publicKey())

        let account = await getAccountInfo(server, admin.publicKey())
        await addTrust(server, asset, account, admin)

        account = await getAccountInfo(server, tokenKeypair.publicKey())
        await mint(server, asset, admin.publicKey(), '100000000000', account, tokenKeypair)
    }

    const contractConfigData = {
        contractId,
        contractType,
        dataSource,
        admin: admin.publicKey(),
        token: tokenData.tokenId,
        initAmount: '100000000000',
        developer: nodes[0]
    }

    await updateAdminToMultiSigAccount(server, admin, nodes)

    const config = generateContractConfig(contractConfigData)
    return config
}

/**
 * @param {{isInitNode: boolean, stellarCore: boolean}[]} nodeConfigs
 * @param {{dataSource: any}[]} contractConfigs
 */
async function generateNewCluster(nodeConfigs, contractConfigs) {

    const server = new rpc.Server(constants.rpcUrl, {allowHttp: true})

    await ensureTokenData()
    await ensureRSAKeys()

    //generate system account
    const systemAccount = Keypair.random()
    await createAccount(systemAccount.publicKey())

    console.log('System secret:' + systemAccount.secret())

    //generate nodes keypairs
    for (let i = 0; i < nodeConfigs.length; i++) {
        const nodeConfig = nodeConfigs[i]
        nodeConfig.keypair = Keypair.fromSecret(nodeConfig.secret)
    }

    const nodes = nodeConfigs.filter(n => n.isInitNode).map(n => n.keypair.publicKey())
    await updateAdminToMultiSigAccount(server, systemAccount, nodes)

    //generate contract configs
    const contracts = {}
    for (const contractConfig of contractConfigs) {
        const {dataSource} = contractConfig
        const config = await generateNewContract(server, nodes, ContractTypes.ORACLE, dataSource)
        contracts[config.contractId] = config
    }

    const subscriptionsContract = await generateNewContract(server, nodes, ContractTypes.SUBSCRIPTIONS)
    contracts[subscriptionsContract.contractId] = subscriptionsContract

    const daoContract = await generateNewContract(server, nodes, ContractTypes.DAO)
    contracts[daoContract.contractId] = daoContract

    const config = generateConfig(systemAccount.publicKey(), contracts, nodes, constants.wasmHash, constants.minDate, 'testnet', 30347, rsa.privateKey)
    fs.mkdirSync(configsPath, {recursive: true})
    const configPath = path.join(configsPath, '.config.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {encoding: 'utf-8'})

    for (let i = 0; i < nodeConfigs.length; i++) {
        const nodeConfig = nodeConfigs[i]
        const appConfig = generateAppConfig(nodeConfig.keypair.secret(), constants.getDataSources(), i)
        const nodeHomeDir = getReflectorHomeDirName(i)
        fs.mkdirSync(nodeHomeDir, {recursive: true})
        fs.writeFileSync(path.join(nodeHomeDir, 'app.config.json'), JSON.stringify(appConfig, null, 2), {encoding: 'utf-8'})
        if (nodeConfig.isInitNode) {
            fs.copyFileSync(configPath, path.join(nodeHomeDir, '.config.json'))
        }
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

            const startCommand = `docker run -d -p ${port}:30347 -v "${nodeHomeDir}:/reflector-node/app/home" --restart=unless-stopped --name=${nodeName} reflector-node-dev`

            console.log(startCommand)
            await runCommand(startCommand)
        } catch (e) {
            console.error(e)
        }
    }
}

async function ensureTokenData() {
    const tokenDataFile = path.join('./tests', 'token-data.json')
    if (!fs.existsSync(tokenDataFile)) {
        const tokenAdmin = Keypair.random()
        await createAccount(tokenAdmin.publicKey())
        const tokenContract = await generateAssetContract(`XRF:${tokenAdmin.publicKey()}`, tokenAdmin.secret())
        tokenData = {secret: tokenAdmin.secret(), publicKey: tokenAdmin.publicKey(), tokenId: tokenContract}
        fs.writeFileSync(tokenDataFile, JSON.stringify(tokenData, null, 2), {encoding: 'utf-8'})
    } else
        tokenData = JSON.parse(fs.readFileSync(tokenDataFile, {encoding: 'utf-8'}))
}

async function ensureRSAKeys() {
    const rsaDataFile = path.join('./tests', 'rsa.json')
    if (!fs.existsSync(rsaDataFile)) {
        const rsaKeys = await generateRSAKeyPair()
        const privateKey = Buffer.from(rsaKeys.privateKey).toString('base64')
        const pubKey = Buffer.from(rsaKeys.publicKey).toString('base64')
        rsa = {privateKey, pubKey}
        fs.writeFileSync('./tests/rsa.json', JSON.stringify(rsa, null, 2), {encoding: 'utf-8'})
    } else
        rsa = JSON.parse(fs.readFileSync(rsaDataFile, {encoding: 'utf-8'}))
}

/**
 * @param {{isInitNode: boolean}[]} nodes
 * @param {{dataSource: any}[]} contractConfigs
 */
async function run(nodes, contractConfigs) {
    if (!fs.existsSync(configsPath)) {
        await generateNewCluster(nodes, contractConfigs)
    }
    await startNodes(getNodesCount())
}

const nodeConfigs = [
    {isInitNode: true, secret: 'SCGO5GR4ZDAXU7BECOIFRO5J3STD2HQECPG4X3XQ4K75VZ64WOFVLQHR'},
    {isInitNode: true, secret: 'SDMHSB2JYLSEMHCX6ZZX7X42YHOZSNNK3JOLAOQE7ORC63IJHWDIBCJ4'},
    {isInitNode: true, secret: 'SB5KAGPBW3AIBUYGYQSMPKSGLLZSKJNRPLFQF4CDGKNKTZQ6XZJTWASO'}
]

const contractConfigs = [
    {dataSource: constants.sources.pubnet},
    {dataSource: constants.sources.exchanges}
]

run(nodeConfigs, contractConfigs).catch(console.error)