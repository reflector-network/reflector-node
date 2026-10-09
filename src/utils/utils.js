const isDebugging = () => {
    const isDebug = process.env.DEBUG === 'true'
    return isDebug
}

/**
 * Rejects when the promise has not settled within the budget. The underlying promise keeps running; its result is
 * discarded and a late rejection is swallowed, so it cannot surface as an unhandled rejection.
 * @param {Promise<any>|any} promise - promise to bound; a plain value counts as already settled
 * @param {number} timeout - budget in milliseconds
 * @param {string} message - error message used when the budget is exhausted
 * @returns {Promise<any>}
 */
function withDeadline(promise, timeout, message) {
    const bounded = Promise.resolve(promise)
    //this runs before the zero-budget guard on purpose: the caller's promise is already in flight either way, and an
    //unobserved rejection from it would take the process down under --unhandled-rejections=throw. It is not a
    //swallowed error - the race below is what reports the failure to the caller
    bounded.catch(() => {})
    if (!(timeout > 0))
        return Promise.reject(new Error(message))
    let timeoutId = null
    const deadline = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeout)
    })
    //cleared on every outcome, so a read that answered in time leaves no live timer behind
    return Promise.race([bounded, deadline]).finally(() => clearTimeout(timeoutId))
}

module.exports = {
    isDebugging,
    withDeadline
}
