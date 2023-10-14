const UpdateBase = require('./update-base')
const UpdateType = require('./update-type')

class ContractUpdate extends UpdateBase {
    /**
     * @param {BigInt} timestamp - pending update timestamp
     * @param {string} wasmHash - contract wasm hash
     */
    constructor(timestamp, wasmHash) {
        super(UpdateType.CONTRACT, timestamp)
        if (!wasmHash || wasmHash.length !== 64)
            throw new Error('wasmHash is not valid')
        this.wasmHash = wasmHash
    }

    toPlainObject() {
        return {
            ...super.toPlainObject(),
            wasmHash: this.wasmHash
        }
    }
}

module.exports = ContractUpdate