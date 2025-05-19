const {AsyncLocalStorage} = require('node:async_hooks')
const storage = new AsyncLocalStorage()
const {v4: uuidv4} = require('uuid')

/**
 * @param {function} fn - function to run in the context
 * @returns {Promise<any>}
 */
const runWithContext = async (fn) =>
    await storage.run({id: uuidv4()}, async () => await fn())

/**
 * @param {function} fn - function to run in the context
 * @returns {any}
 */
const runWithContextSync = (fn) => storage.run({id: uuidv4()}, () => fn())

module.exports = {storage, runWithContext, runWithContextSync}