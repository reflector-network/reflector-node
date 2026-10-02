const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {spawn} = require('child_process')
const {settings, readJson, writeJson, stateFile} = require('./env')
const {until} = require('./wait')

//the orchestrator reads ./home/app.config.json from its working directory, so the runner gives it one of its own beside
//the cluster state; the maintainer's own orchestrator home is never touched
const workDir = () => stateFile('orchestrator')
const stateJson = () => stateFile('orchestrator.json')

/**
 * @param {string} connectionString - MongoDB connection string
 * @param {string} name - database name
 * @returns {string} the same connection with the database replaced
 */
function withDatabase(connectionString, name) {
    const url = new URL(connectionString)
    url.pathname = '/' + name
    return url.toString()
}

/**
 * @param {object} template - an orchestrator app config to copy (network, email and log settings)
 * @param {{dbName: string, port: number, defaultNodes: string[]}} overrides - what the runner sets
 * @returns {object}
 */
function buildAppConfig(template, {dbName, port, defaultNodes}) {
    return {...structuredClone(template), port, dbConnectionString: withDatabase(template.dbConnectionString, dbName), defaultNodes}
}

/**
 * @returns {string} a database name no earlier run used, so a reset never has to drop anything
 */
function newDatabaseName() {
    return `reflector-orchestrator-e2e-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`
}

function state() {
    return readJson(stateJson(), {})
}

async function isUp() {
    try {
        return (await fetch(`${settings.orchestratorUrl}/nodes`)).ok
    } catch (err) {
        return false
    }
}

/**
 * Writes the runner's orchestrator config: the maintainer's config with its own database and default node set
 * @param {{dbName: string, defaultNodes: string[]}} options - database and the keys that may post the first config
 */
function prepare({dbName, defaultNodes}) {
    const template = readJson(path.join(settings.orchestratorDir, 'home', 'app.config.json'))
    if (!template)
        throw new Error(`No orchestrator config to copy at ${settings.orchestratorDir}/home/app.config.json`)
    const port = Number(new URL(settings.orchestratorUrl).port)
    writeJson(path.join(workDir(), 'home', 'app.config.json'), buildAppConfig(template, {dbName, port, defaultNodes}))
    writeJson(stateJson(), {...state(), dbName})
}

/**
 * Starts the orchestrator in the background; it outlives the runner and is stopped with stop()
 * @param {function(string)} [log] - progress output
 */
async function start(log = () => {}) {
    if (await isUp())
        throw new Error(`Something already answers on ${settings.orchestratorUrl}; stop it first`)
    if (!fs.existsSync(path.join(workDir(), 'home', 'app.config.json')))
        throw new Error('The runner has no orchestrator config yet; run bootstrap')
    const out = fs.openSync(path.join(workDir(), 'orchestrator.out.log'), 'a')
    const child = spawn(process.execPath, [path.join(settings.orchestratorDir, 'index.js')], {
        cwd: workDir(),
        env: {...process.env, NODE_ENV: 'production'},
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, out]
    })
    child.unref()
    writeJson(stateJson(), {...state(), pid: child.pid})
    log(`orchestrator started (pid ${child.pid}, database ${state().dbName})`)
    await until(isUp, {timeout: 60000, every: 1000, describe: 'the orchestrator to answer'})
}

/**
 * Stops the orchestrator the runner started, if it still runs
 */
async function stop() {
    const {pid} = state()
    if (pid) {
        try {
            process.kill(pid)
        } catch (err) {
            //already gone
        }
        writeJson(stateJson(), {...state(), pid: null})
    }
    await until(async () => !await isUp(), {timeout: 30000, every: 1000, describe: 'the orchestrator to stop'})
}

/**
 * Starts the runner's orchestrator unless something already answers on its url
 * @param {function(string)} [log] - progress output
 */
async function ensureRunning(log = () => {}) {
    if (await isUp())
        return
    await start(log)
}

module.exports = {withDatabase, buildAppConfig, newDatabaseName, state, isUp, prepare, start, stop, ensureRunning}
