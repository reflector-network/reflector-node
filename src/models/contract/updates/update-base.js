class UpdateBase {
    /**
     * @param {number} type - pending update type
     * @param {number} timestamp - pending update timestamp
     */
    constructor(type, timestamp) {
        if (this.constructor === UpdateBase)
            throw new Error('UpdateBase is abstract class')
        if (!type)
            throw new Error('type is required')
        if (!timestamp)
            throw new Error('timestamp is required')
        this.type = type
        this.timestamp = timestamp
    }

    toPlainObject() {
        return {
            type: this.type,
            timestamp: this.timestamp
        }
    }
}

module.exports = UpdateBase