const fs = require('fs')
const container = require('../domain/container')
const {writeFileAtomic} = require('../utils/fs-helper')

const nonceFile = `${container.homeDir}/.nonce.json`

/**
 * Reads the stored nonces. A file that exists but cannot be used is never replaced by an empty set: every nonce would
 * fall to 0 and reopen the replay of every CONFIG, PENDING_CONFIG and GATEWAYS envelope this node has accepted. Boot
 * stops instead, naming the file, which is left as it is for the operator. Writes are atomic, so a crash no
 * longer tears the file
 * @returns {Object.<string, number>}
 */
function loadNonces() {
    if (!fs.existsSync(nonceFile))
        return {}
    let parsed = null
    try {
        parsed = JSON.parse(fs.readFileSync(nonceFile).toString().trim())
    } catch (err) {
        throw new Error(`${nonceFile} cannot be parsed. Restore it from a backup; deleting it resets replay protection to zero`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`${nonceFile} does not hold a nonce object. Restore it from a backup; deleting it resets replay protection to zero`)
    return parsed
}

const nonces = loadNonces()

const nonceTypes = {
    CONFIG: 'config',
    PENDING_CONFIG: 'pendingConfig',
    GATEWAYS: 'gateways',
    //the lowest counted nonce of the config this node last adopted; kept apart from CONFIG, which records this node's
    //own votes
    CONFIG_FLOOR: 'configFloor',
    //orchestrator control messages, each stored per signer as `${type}:${pubkey}`
    SET_TRACE: 'setTrace',
    LOGS: 'logs',
    LOG_FILE: 'logFile'
}

//Rename nonce type '3' to 'config'
if (nonces['3']) {
    nonces[nonceTypes.CONFIG] = nonces['3']
    delete nonces['3']
}

function setNonce(messageType, nonce) {
    nonces[messageType] = nonce
    writeFileAtomic(nonceFile, JSON.stringify(nonces, null, 2))
}

const nonceManager = {
    getNonce(messageType) {
        return nonces[messageType] || 0
    },
    setNonce(messageType, nonce) {
        setNonce(messageType, nonce)
    },
    nonceTypes
}

module.exports = nonceManager