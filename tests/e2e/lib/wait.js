const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {any} value - hash, key or id
 * @returns {string} its first eight characters
 */
function short(value) {
    return typeof value === 'string' ? value.slice(0, 8) : String(value)
}

/**
 * @param {number} ts - time, ms
 * @param {number} [step] - grid step, ms
 * @returns {number} the first grid time at or after ts
 */
function gridCeil(ts, step = 120000) {
    return Math.ceil(ts / step) * step
}

/**
 * Sleeps, checking for cancellation as it goes
 * @param {number} ms - how long
 * @param {function(): boolean} isCancelled - cancellation check
 * @param {number} [step] - how often to check, ms
 * @returns {Promise<void>} rejects with Cancelled once cancellation is requested
 */
async function cancellableSleep(ms, isCancelled, step = 1000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (isCancelled())
            throw new Error('Cancelled')
        await sleep(Math.min(step, end - Date.now()))
    }
}

/**
 * Polls until fn returns a truthy value
 * @param {function(): any} fn - condition, may be async; a throw counts as "not yet"
 * @param {object} options - timeout (ms), every (ms), describe, log(message), isCancelled()
 * @returns {Promise<any>}
 */
async function until(fn, {timeout, every = 5000, describe = 'condition', log = () => {}, isCancelled = () => false}) {
    const started = Date.now()
    let lastLog = started
    let lastError = null
    for (;;) {
        if (isCancelled())
            throw new Error('Cancelled')
        try {
            const value = await fn()
            if (value)
                return value
            lastError = null
        } catch (err) {
            lastError = err
        }
        const elapsed = Date.now() - started
        if (elapsed >= timeout)
            throw new Error(`Timed out after ${Math.round(elapsed / 1000)} s waiting for ${describe}${lastError ? ': ' + lastError.message : ''}`)
        if (Date.now() - lastLog >= 60000) {
            log(`still waiting for ${describe} (${Math.round(elapsed / 1000)} s)`)
            lastLog = Date.now()
        }
        await sleep(Math.min(every, timeout - elapsed))
    }
}

module.exports = {sleep, cancellableSleep, short, gridCeil, until}
