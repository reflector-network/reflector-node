class ValidationError extends Error {
    constructor(message) {
        super(message)
    }

    details

    toString() {
        const message = `Message: ${this.message}`
        if (!this.details) return message
        return `${message}\nDetails: ${this.details}`
    }
}

module.exports = ValidationError