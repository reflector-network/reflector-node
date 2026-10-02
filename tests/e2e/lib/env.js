const fs = require('fs')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')

const clusterDir = process.env.E2E_CLUSTER_DIR || path.resolve(__dirname, '..', '..', 'cluster', 'clusterData')
const stateDir = path.join(clusterDir, 'e2e')

const settings = {
    orchestratorUrl: process.env.E2E_ORCHESTRATOR_URL || 'http://localhost:12274',
    orchestratorDir: path.resolve(__dirname, '..', '..', '..', '..', 'node-orchestrator'),
    contractRepo: path.resolve(__dirname, '..', '..', '..', '..', 'reflector-contract'),
    image: process.env.E2E_IMAGE || 'reflector-node-dev',
    passphrase: 'Test SDF Network ; September 2015',
    sorobanRpc: ['https://soroban-testnet.stellar.org'],
    horizonUrl: 'https://horizon-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
    pubnetRpc: ['http://localhost:8003'],
    basePort: 30347,
    portStep: 100,
    expirationMs: 8 * 24 * 60 * 60 * 1000
}

/**
 * @param {string} file - JSON file
 * @param {any} [fallback] - value when the file does not exist
 * @returns {any}
 */
function readJson(file, fallback = null) {
    if (!fs.existsSync(file))
        return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * @param {string} file - JSON file, created with its folder when missing
 * @param {any} value - value to write
 */
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/**
 * @param {number} index - node index
 * @returns {string} the node's home folder
 */
function nodeHome(index) {
    return path.join(clusterDir, `node${index}`, 'reflector-home')
}

/**
 * @param {number} index - node index
 * @returns {number} the port a node at this index listens on unless a scenario moved it
 */
function defaultPort(index) {
    return settings.basePort + index * settings.portStep
}

/**
 * @param {string} name - file name
 * @returns {string} path of a runner state file
 */
function stateFile(name) {
    return path.join(stateDir, name)
}

/**
 * Every node home under the cluster folder that holds an app.config.json, by index
 * @returns {{index: number, home: string, keypair: Keypair, pubkey: string, appConfig: object}[]}
 */
function listNodes() {
    if (!fs.existsSync(clusterDir))
        return []
    return fs.readdirSync(clusterDir)
        .map(name => /^node(\d+)$/.exec(name))
        .filter(Boolean)
        .map(match => Number(match[1]))
        .sort((a, b) => a - b)
        .map(index => {
            const home = nodeHome(index)
            const appConfig = readJson(path.join(home, 'app.config.json'))
            if (!appConfig)
                return null
            const keypair = Keypair.fromSecret(appConfig.secret)
            return {index, home, keypair, pubkey: keypair.publicKey(), appConfig}
        })
        .filter(Boolean)
}

/**
 * Spare node keys, generated once and kept with the runner state
 * @param {number} [count] - how many spares to keep at least
 * @returns {{secret: string, pubkey: string}[]}
 */
function spareKeys(count = 2) {
    const file = stateFile('spare-nodes.json')
    const keys = readJson(file, [])
    while (keys.length < count) {
        const kp = Keypair.random()
        keys.push({secret: kp.secret(), pubkey: kp.publicKey()})
    }
    writeJson(file, keys)
    return keys
}

/**
 * Every key the runner can sign with: node homes first, then spares that have no home yet
 * @returns {{pubkey: string, keypair: Keypair, index: ?number}[]}
 */
function knownKeys() {
    const nodes = listNodes()
    const homed = new Set(nodes.map(n => n.pubkey))
    return [
        ...nodes.map(n => ({pubkey: n.pubkey, keypair: n.keypair, index: n.index})),
        ...spareKeys()
            .filter(k => !homed.has(k.pubkey))
            .map(k => ({pubkey: k.pubkey, keypair: Keypair.fromSecret(k.secret), index: null}))
    ]
}

/**
 * @param {string} pubkey - node public key
 * @returns {Keypair}
 */
function keypairOf(pubkey) {
    const key = knownKeys().find(k => k.pubkey === pubkey)
    if (!key)
        throw new Error(`No local secret for ${pubkey}`)
    return key.keypair
}

/**
 * Creates the home of a node that has none yet, at the next free index
 * @param {Keypair} keypair - node key
 * @param {object} template - app config to copy (another node's)
 * @returns {{index: number, home: string, keypair: Keypair, pubkey: string, appConfig: object}}
 */
function createNodeHome(keypair, template) {
    const nodes = listNodes()
    const index = nodes.length ? Math.max(...nodes.map(n => n.index)) + 1 : 0
    const home = nodeHome(index)
    const appConfig = {...structuredClone(template), secret: keypair.secret(), port: defaultPort(index)}
    delete appConfig.clusterConfigHash
    writeJson(path.join(home, 'app.config.json'), appConfig)
    return {index, home, keypair, pubkey: keypair.publicKey(), appConfig}
}

module.exports = {
    settings,
    clusterDir,
    stateDir,
    readJson,
    writeJson,
    nodeHome,
    defaultPort,
    stateFile,
    listNodes,
    spareKeys,
    knownKeys,
    keypairOf,
    createNodeHome
}
