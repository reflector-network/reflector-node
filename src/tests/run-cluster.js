const fs = require('fs')
const path = require('path')
const {SorobanRpc, Keypair} = require('stellar-sdk')
const {buildContract, deployContract, createAccount, updateAdminToMultiSigAccount, generateContractConfig: generateSingleConfig, runCommand, bumpContract, generateAppConfig, generateConfig} = require('./utils')
const constants = require('./constants')

const configsPath = './tests/clusterData'

function getNodeFolderName(nodeNumber) {
    return path.join(configsPath, `node${nodeNumber}`)
}

function getStellarFolderName(nodeNumber) {
    return path.join(getNodeFolderName(nodeNumber), 'stellar')
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
    await buildContract() //if api - build contract with generic asset
    const admin = Keypair.random()
    await createAccount(server, admin.publicKey())
    const contractId = await deployContract(admin.secret())
    if (!contractId) {
        throw new Error('Contract was not deployed')
    }
    //await bumpContract(server, admin, contractId)
    await updateAdminToMultiSigAccount(server, admin, nodes)

    const config = generateSingleConfig(admin.publicKey(), contractId, dataSource)
    return config
}

/**
 * @param {{isInitNode: boolean, stellarCore: boolean}[]} nodeConfigs
 * @param {{dataSource: any}[]} contractConfigs
 */
async function generateNewCluster(nodeConfigs, contractConfigs) {

    const server = new SorobanRpc.Server(constants.rpcUrl)
    //generate system account
    const systemAccount = Keypair.random()
    await createAccount(server, systemAccount.publicKey())

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
        const appConfig = generateAppConfig(nodeConfig.keypair.secret(), constants.sources)
        const nodeHomeFolder = getReflectorHomeFolderName(i)
        fs.mkdirSync(nodeHomeFolder, {recursive: true})
        fs.writeFileSync(path.join(nodeHomeFolder, 'app.config.json'), JSON.stringify(appConfig, null, 2), {encoding: 'utf-8'})
        if (nodeConfig.isInitNode) {
            fs.copyFileSync(configPath, path.join(nodeHomeFolder, '.config.json'))
        }
        if (nodeConfig.stellarCore) {
            const stellarData = getStellarFolderName(i)
            fs.mkdirSync(stellarData, {recursive: true})
        }
    }
}

async function startNodes(nodesCount) {
    for (let i = 0; i < nodesCount; i++) {
        console.log(`Starting node ${i}`)
        const nodeHomeFolder = path.resolve(getReflectorHomeFolderName(i))
        const stellarFolderName = path.resolve(getStellarFolderName(i))
        const nodeName = `node${i}`
        const port = 30347 + (i * 100)
        const wsPort = 30348 + (i * 100)
        //closeEndRemoveIfExist(nodeName)

        const {secret} = JSON.parse(fs.readFileSync(path.join(nodeHomeFolder, 'app.config.json')).toString().trim())

        let startCommand = null
        if (fs.existsSync(stellarFolderName)) {
            const horizonPort = 8100 + (i * 100)
            startCommand = `docker run -d -p ${horizonPort}:8000 -p ${port}:30347 -p ${wsPort}:30348 -e SECRET=${secret} -e NODE_ENV=development -v "${nodeHomeFolder}:/reflector-node/app/home" -v "${stellarFolderName}:/opt/stellar" --restart=unless-stopped --name=${nodeName} reflector-node-stellar-core:latest --testnet --enable-soroban-rpc`
        } else
            startCommand = `docker run -d -p ${port}:30347 -p ${wsPort}:30348 -e SECRET=${secret} -e NODE_ENV=development -v "${nodeHomeFolder}:/reflector-node/app/home" --restart=unless-stopped --name=${nodeName} reflector-node-standalone:latest`

        console.log(startCommand)
        //await runCommand(startCommand)
    }
}

/**
 * @param {{isInitNode: boolean, stellarCore: boolean}[]} nodes
 * @param {{dataSource: any}[]} contractConfigs
 */
async function run(nodes, contractConfigs) {
    if (!fs.existsSync(configsPath)) {
        await generateNewCluster(nodes, contractConfigs)
    }
    await startNodes(getNodesCount())
}

const nodeConfigs = [
    {isInitNode: true, stellarCore: false}
    //{ isInitNode: false, stellarCore: false },
    //{ isInitNode: false, stellarCore: true },
    //{ isInitNode: false, stellarCore: false },
    //{ isInitNode: false, stellarCore: true },
    //{ isInitNode: false, stellarCore: true }
]

const contractConfigs = [
    {dataSource: constants.sources.pubnet},
    {dataSource: constants.sources.coinmarketcap}
]

run(nodeConfigs, contractConfigs).catch(console.error)