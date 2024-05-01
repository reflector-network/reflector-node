const isDebugging = () => {
    const isDebug = process.env.DEBUG === 'true'
    return isDebug
}

module.exports = {
    isDebugging
}