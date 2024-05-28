const fs = require('fs')
const path = require('path')
const {SorobanRpc, Keypair} = require('@stellar/stellar-sdk')
const {deployContract, createAccount, updateAdminToMultiSigAccount, generateContractConfig: generateSingleConfig, runCommand, generateAppConfig, generateConfig} = require('./utils')
const constants = require('./constants')

const configsPath = './tests/clusterData'

function getNodeFolderName(nodeNumber) {
    return path.join(configsPath, `node${nodeNumber}`)
}

function getReflectorHomeFolderName(nodeNumber) {
    return path.join(getNodeFolderName(nodeNumber), 'reflector-home')
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
 * @param {{type: string}} dataSource
 */
async function generateNewContract(server, nodes, dataSource) {
    const admin = Keypair.random()
    await createAccount(server, admin.publicKey())
    console.log('Admin ' + admin.publicKey() + ' secret:' + admin.secret())
    const contractId = await deployContract(admin.secret())
    if (!contractId) {
        throw new Error('Contract was not deployed')
    }

    await updateAdminToMultiSigAccount(server, admin, nodes)

    const config = generateSingleConfig(admin.publicKey(), contractId, dataSource)
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
        nodeConfig.keypair = Keypair.random()
    }

    const nodes = nodeConfigs.filter(n => n.isInitNode).map(n => n.keypair.publicKey())
    await updateAdminToMultiSigAccount(server, systemAccount, nodes)

    //generate contract configs
    const contracts = {}
    for (const contractConfig of contractConfigs) {
        const config = await generateNewContract(server, nodes, contractConfig.dataSource)
        contracts[config.oracleId] = config
    }

    const config = generateConfig(systemAccount.publicKey(), contracts, nodes, constants.wasmHash, constants.minDate, 'testnet', 30347, false)
    fs.mkdirSync(configsPath, {recursive: true})
    const configPath = path.join(configsPath, '.config.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {encoding: 'utf-8'})

    for (let i = 0; i < nodeConfigs.length; i++) {
        const nodeConfig = nodeConfigs[i]
        const appConfig = generateAppConfig(nodeConfig.keypair.secret(), constants.getDataSources())
        const nodeHomeFolder = getReflectorHomeFolderName(i)
        fs.mkdirSync(nodeHomeFolder, {recursive: true})
        fs.writeFileSync(path.join(nodeHomeFolder, 'app.config.json'), JSON.stringify(appConfig, null, 2), {encoding: 'utf-8'})
        if (nodeConfig.isInitNode) {
            fs.copyFileSync(configPath, path.join(nodeHomeFolder, '.config.json'))
        }
    }
}

async function startNodes(nodesCount) {
    for (let i = 0; i < nodesCount; i++) {
        console.log(`Starting node ${i}`)
        const nodeHomeFolder = path.resolve(getReflectorHomeFolderName(i))
        const nodeName = `node${i}`
        const port = 30347 + (i * 100)
        //closeEndRemoveIfExist(nodeName)

        const startCommand = `docker run -d -p ${port}:30347 -e NODE_ENV=development -v "${nodeHomeFolder}:/reflector-node/app/home" --restart=unless-stopped --name=${nodeName} reflector-node-dev`

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
    {isInitNode: true},
    {isInitNode: true},
    {isInitNode: false}
]

const contractConfigs = [
    {dataSource: constants.sources.pubnet},
    {dataSource: constants.sources.coinmarketcap},
    {dataSource: constants.sources.exchanges}
]

run(nodeConfigs, contractConfigs).catch(console.error)