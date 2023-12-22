const fs = require('fs')

const nonceFile = './home/.nonce.json'

const nonces = fs.existsSync(nonceFile) ? JSON.parse(fs.readFileSync(nonceFile).toString().trim()) : {}

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
    }
}

module.exports = nonceManager