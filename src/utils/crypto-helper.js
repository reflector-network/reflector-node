if (!globalThis.crypto) {
    globalThis.crypto = require('node:crypto').webcrypto
}
const {importRSAKey, sha256, decrypt, generateRSAKeyPair, encrypt} = require('@reflector/reflector-subscription-encryption')

function randomUUID() {
    return crypto.randomUUID()
}

module.exports = {
    importRSAKey,
    sha256,
    decrypt,
    randomUUID,
    generateRSAKeyPair,
    encrypt
}