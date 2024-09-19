const https = require('https')
const http = require('http')
const {default: axios} = require('axios')

const defaultAgentOptions = {keepAlive: true, maxSockets: 50, noDelay: true}

const httpAgent = new http.Agent(defaultAgentOptions)
axios.defaults.httpAgent = httpAgent

const httpsAgent = new https.Agent(defaultAgentOptions)
axios.defaults.httpsAgent = httpsAgent

/**
 * @param {string} url - request url
 * @param {any} [options] - request options
 * @returns {Promise<any>}
 * @protected
 */
async function makeRequest(url, options = {}) {
    const requestOptions = {
        ...options,
        url
    }

    const response = await axios.request(requestOptions)
    return response
}

module.exports = {
    makeRequest
}