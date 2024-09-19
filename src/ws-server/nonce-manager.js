const fs = require('fs')
const container = require('../domain/container')

const nonceFile = `${container.homeDir}/.nonce.json`

const nonces = fs.existsSync(nonceFile) ? JSON.parse(fs.readFileSync(nonceFile).toString().trim()) : {}

const nonceTypes = {
    CONFIG: 'config',
    PENDING_CONFIG: 'pendingConfig',
    GATEWAYS: 'gateways'
}

//Rename nonce type '3' to 'config'
if (nonces['3']) {
    nonces[nonceTypes.CONFIG] = nonces['3']
    delete nonces['3']
}

function setNonce(messageType, nonce) {
    nonces[messageType] = nonce
    fs.writeFileSync(nonceFile, JSON.stringify(nonces, null, 2))
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