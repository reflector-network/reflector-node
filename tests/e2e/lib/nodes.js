const fs = require('fs')
const net = require('net')
const path = require('path')
const {execFile} = require('child_process')
const {settings, nodeHome, readJson, writeJson, stateFile} = require('./env')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function docker(args) {
    return new Promise((resolve, reject) => {
        execFile('docker', args, (error, stdout, stderr) => {
            if (error)
                return reject(new Error(`docker ${args.join(' ')} failed: ${(stderr || error.message).trim()}`))
            resolve(stdout.trim())
        })
    })
}

function containerName(index) {
    return `node${index}`
}

/**
 * @param {number} index - node index
 * @returns {string[]} docker arguments that start the node
 */
function runArgs(index) {
    return [
        'run', '-d', '--network', 'host',
        '-v', `${path.resolve(nodeHome(index))}:/reflector-node/app/home`,
        '--restart=unless-stopped', `--name=${containerName(index)}`, settings.image
    ]
}

const appConfigFile = index => path.join(nodeHome(index), 'app.config.json')
const backupFile = index => path.join(nodeHome(index), 'app.config.e2e-backup.json')

function readAppConfig(index) {
    return readJson(appConfigFile(index))
}

function writeAppConfig(index, config) {
    writeJson(appConfigFile(index), config)
}

/**
 * Edits the app config for a scenario; the first edit keeps a backup that restoreAppConfig puts back
 * @param {number} index - node index
 * @param {function(object): (object|void)} fn - edits the config in place or returns a new one
 */
function editAppConfig(index, fn) {
    if (!fs.existsSync(backupFile(index)))
        fs.copyFileSync(appConfigFile(index), backupFile(index))
    const config = readAppConfig(index)
    writeAppConfig(index, fn(config) || config)
}

/**
 * @param {number} index - node index
 * @returns {boolean} whether a backup was restored
 */
function restoreAppConfig(index) {
    if (!fs.existsSync(backupFile(index)))
        return false
    fs.copyFileSync(backupFile(index), appConfigFile(index))
    fs.unlinkSync(backupFile(index))
    return true
}

/**
 * @returns {number[]} indexes of the node homes whose app config still carries a scenario edit
 */
function editedHomes() {
    const {clusterDir} = require('./env')
    if (!fs.existsSync(clusterDir))
        return []
    return fs.readdirSync(clusterDir)
        .map(name => /^node(\d+)$/.exec(name))
        .filter(Boolean)
        .map(match => Number(match[1]))
        .filter(index => fs.existsSync(backupFile(index)))
        .sort((a, b) => a - b)
}

function resetJoinState(index) {
    for (const name of ['.config.json', '.pending.config.json', '.nonce.json'])
        fs.rmSync(path.join(nodeHome(index), name), {force: true})
}

function pendingFile(index) {
    return readJson(path.join(nodeHome(index), '.pending.config.json'))
}

function startTimes() {
    return readJson(stateFile('node-starts.json'), {})
}

const historyMs = 6 * 60 * 60000

/**
 * @returns {number[]} every recorded node start of the last hours, oldest first: a restart is not forgotten when the
 * same node restarts again later in a scenario
 */
function startHistory() {
    return readJson(stateFile('node-start-history.json'), [])
}

/**
 * @param {number} index - node index
 * @param {number} [time] - start time, ms
 */
function recordStart(index, time = Date.now()) {
    const starts = startTimes()
    starts[index] = time
    writeJson(stateFile('node-starts.json'), starts)
    writeJson(stateFile('node-start-history.json'), [...startHistory().filter(t => time - t < historyMs), time])
}

async function exists(index) {
    try {
        await docker(['inspect', containerName(index)])
        return true
    } catch (err) {
        return false
    }
}

async function isRunning(index) {
    try {
        return (await docker(['inspect', '-f', '{{.State.Running}}', containerName(index)])) === 'true'
    } catch (err) {
        return false
    }
}

async function waitPort(port, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const open = await new Promise(resolve => {
            const socket = net.connect(port, '127.0.0.1')
            socket.once('connect', () => {
                socket.destroy()
                resolve(true)
            })
            socket.once('error', () => resolve(false))
        })
        if (open)
            return
        await sleep(2000)
    }
    throw new Error(`Port ${port} did not open within ${timeoutMs / 1000} s; is Docker host networking enabled?`)
}

async function remove(index) {
    if (await exists(index))
        await docker(['rm', '-f', containerName(index)])
}

async function start(index) {
    await remove(index)
    await docker(runArgs(index))
    recordStart(index)
    await waitPort(readAppConfig(index).port)
}

async function stop(index) {
    if (await isRunning(index))
        await docker(['stop', containerName(index)])
}

async function restart(index) {
    if (!await exists(index))
        return start(index)
    await docker(['restart', containerName(index)])
    recordStart(index)
    await waitPort(readAppConfig(index).port)
}

/**
 * @param {number} index - node index
 * @param {number} sinceMs - earliest entry time
 * @returns {object[]} parsed entries of every combined log, oldest first
 */
function readLogLines(index, sinceMs) {
    const dir = path.join(nodeHome(index), 'logs')
    if (!fs.existsSync(dir))
        return []
    const entries = []
    for (const name of fs.readdirSync(dir).filter(f => f.endsWith('combined.log'))) {
        const file = path.join(dir, name)
        if (fs.statSync(file).mtimeMs < sinceMs)
            continue
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line)
                continue
            let entry = null
            try {
                entry = JSON.parse(line)
            } catch (err) {
                continue
            }
            if (Date.parse(entry.time) >= sinceMs)
                entries.push(entry)
        }
    }
    return entries.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
}

module.exports = {
    containerName,
    runArgs,
    isRunning,
    start,
    stop,
    remove,
    restart,
    readAppConfig,
    writeAppConfig,
    editAppConfig,
    restoreAppConfig,
    editedHomes,
    resetJoinState,
    pendingFile,
    startTimes,
    startHistory,
    recordStart,
    readLogLines
}
