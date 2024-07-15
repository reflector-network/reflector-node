if (!globalThis.crypto) {
    globalThis.crypto = require('node:crypto').webcrypto
}
const {importRSAKey, sha256, decrypt} = require('@reflector/reflector-subscription-encryption')

module.exports = {
    importRSAKey,
    sha256,
    decrypt
}