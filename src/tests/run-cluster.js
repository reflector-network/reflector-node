const fs = require('fs')
const path = require('path')
const {Server, Keypair} = require('soroban-client')
const {buildContract, deployContract, createAccount, updateAdminToMultiSigAccount, generateSingleConfig, runCommand, bumpContract} = require('./utils')
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
 * @param {{isInitNode: boolean, stellarCore: boolean}[]} nodeConfigs
 */
async function generateNewCluster(nodeConfigs) {
    await buildContract()
    const server = new Server(constants.rpcUrl)
    const admin = Keypair.random()
    await createAccount(server, admin.publicKey())
    const contractId = await deployContract(admin.secret())
    if (!contractId) {
        throw new Error('Contract was not deployed')
    }
    for (let i = 0; i < nodeConfigs.length; i++) {
        const nodeConfig = nodeConfigs[i]
        nodeConfig.keypair = Keypair.random()
    }

    const nodes = nodeConfigs.filter(n => n.isInitNode).map(n => n.keypair.publicKey())
    await updateAdminToMultiSigAccount(server, admin, nodes)

    const config = generateSingleConfig(admin.publicKey(), contractId, nodes, 30348, true, null)
    const configPath = path.join(configsPath, 'app.config.json')
    fs.mkdirSync(configsPath, {recursive: true})
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {encoding: 'utf-8'})

    for (let i = 0; i < nodeConfigs.length; i++) {
        const nodeConfig = nodeConfigs[i]
        const nodeHomeFolder = getReflectorHomeFolderName(i)
        fs.mkdirSync(nodeHomeFolder, {recursive: true})
        fs.writeFileSync(path.join(nodeHomeFolder, '.secret'), nodeConfig.keypair.secret())
        if (nodeConfig.isInitNode) {
            fs.copyFileSync(configPath, path.join(nodeHomeFolder, 'app.config.json'))
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
        closeEndRemoveIfExist(nodeName)

        const secret = fs.readFileSync(path.join(nodeHomeFolder, '.secret')).toString().trim()

        let startCommand = null
        if (fs.existsSync(stellarFolderName)) {
            const horizonPort = 8100 + (i * 100)
            startCommand = `docker run -d -p ${horizonPort}:8000 -p ${port}:30347 -p ${wsPort}:30348 -e SECRET=${secret} -e NODE_ENV=development -v "${nodeHomeFolder}:/reflector-node/app/home" -v "${stellarFolderName}:/opt/stellar" --restart=unless-stopped --name=${nodeName} reflector-node-stellar-core:latest --testnet --enable-soroban-rpc`
        } else
            startCommand = `docker run -d -p ${port}:30347 -p ${wsPort}:30348 -e SECRET=${secret} -e NODE_ENV=development -v "${nodeHomeFolder}:/reflector-node/app/home" --restart=unless-stopped --name=${nodeName} reflector-node-standalone:latest`

        //console.log(startCommand)
        await runCommand(startCommand)
    }
}

/**
 * @param {{isInitNode: boolean, stellarCore: boolean}[]} nodes
 */
async function run(nodes) {
    if (!fs.existsSync(configsPath)) {
        await generateNewCluster(nodes)
    }
    await startNodes(getNodesCount())
}

const nodeConfigs = [
    {isInitNode: true, stellarCore: true},
    {isInitNode: false, stellarCore: true},
    {isInitNode: false, stellarCore: true},
    {isInitNode: false, stellarCore: false},
    {isInitNode: false, stellarCore: true},
    {isInitNode: false, stellarCore: true}
]

run(nodeConfigs).catch(console.error)