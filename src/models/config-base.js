class ConfigBase {
    static notDefined = 'Not defined'
    static invalidOrNotDefined = 'Invalid or not defined'

    __configIssues = []

    __addConfigIssue(issue) {
        this.__configIssues.push(issue)
        return null
    }

    get issues() {
        if (this.isValid)
            return undefined
        return this.__configIssues
    }

    get issuesString() {
        return this.__configIssues.join('\n')
    }

    get isValid() {
        return this.__configIssues.length === 0
    }
}

module.exports = ConfigBase