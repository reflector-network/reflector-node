const fs = require('fs')
const path = require('path')
const {SorobanRpc, Keypair} = require('@stellar/stellar-sdk')
const ContractTypes = require('@reflector/reflector-shared/models/configs/contract-type')
const {deployContract, createAccount, updateAdminToMultiSigAccount, generateContractConfig: generateSingleConfig, runCommand, generateAppConfig, generateConfig, generateAssetContract} = require('./utils')
const constants = require('./constants')

const configsPath = './tests/clusterData'

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
 * @param {SorobanRpc.Server} server
 * @param {string[]} nodes
 * @param {string} contractType
 * @param {string} dataSource
 */
async function generateNewContract(server, nodes, contractType, dataSource) {
    const admin = Keypair.random()
    await createAccount(server, admin.publicKey())
    console.log('Admin ' + admin.publicKey() + ' secret:' + admin.secret())
    const contractId = await deployContract(admin.secret(), contractType)
    if (!contractId) {
        throw new Error('Contract was not deployed')
    }

    const contractConfigData = {
        contractId,
        contractType,
        dataSource,
        admin: admin.publicKey()
    }

    if (contractType === ContractTypes.SUBSCRIPTIONS) {
        const tokenAdmin = Keypair.random()
        await createAccount(server, tokenAdmin.publicKey())
        contractConfigData.token = await generateAssetContract(`SBS:${tokenAdmin.publicKey()}`, admin.secret())
        //save token admin secret
        if (!fs.existsSync(configsPath)) {
            fs.mkdirSync(configsPath, {recursive: true})
        }
        const tokenAdminSecretPath = path.join(configsPath, 'token-data.json')
        fs.writeFileSync(tokenAdminSecretPath, JSON.stringify({secret: tokenAdmin.secret(), publicKey: tokenAdmin.publicKey(), tokenId: contractConfigData.token}), {encoding: 'utf-8'})
    }

    await updateAdminToMultiSigAccount(server, admin, nodes)

    const config = generateSingleConfig(contractConfigData)
    return config
}

/**
 * @param {{isInitNode: boolean, stellarCore: boolean}[]} nodeConfigs
 * @param {{dataSource: any}[]} contractConfigs
 */
async function generateNewCluster(nodeConfigs, contractConfigs) {

    const server = new SorobanRpc.Server(constants.rpcUrl, {allowHttp: true})
    //generate system account
    const systemAccount = Keypair.random()
    await createAccount(server, systemAccount.publicKey())

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
        contracts[config.oracleId] = config
    }

    const subscriptionsContract = await generateNewContract(server, nodes, ContractTypes.SUBSCRIPTIONS)
    contracts[subscriptionsContract.contractId] = subscriptionsContract

    const config = generateConfig(systemAccount.publicKey(), contracts, nodes, constants.wasmHash, constants.minDate, 'testnet', 30347, false)
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
        console.log(`Starting node ${i}`)
        const nodeHomeDir = path.resolve(getReflectorHomeDirName(i))
        const nodeName = `node${i}`
        const port = 30347 + (i * 100)
        //closeEndRemoveIfExist(nodeName)

        const startCommand = `docker run -d -p ${port}:30347 -v "${nodeHomeDir}:/reflector-node/app/home" --restart=unless-stopped --name=${nodeName} reflector-node-dev`

        console.log(startCommand)
        await runCommand(startCommand)
    }
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