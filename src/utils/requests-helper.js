const https = require('https')
const http = require('http')
const {default: axios} = require('axios')
const {resolveAndValidate} = require('./ssrf-validator')

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
    const {validateSsrf, ...axiosOptions} = options

    if (validateSsrf) {
        const {resolvedIp} = await resolveAndValidate(url)
        const safeUrl = new URL(url)
        const originalHost = safeUrl.host
        safeUrl.hostname = safeUrl.hostname === resolvedIp ? resolvedIp : `${resolvedIp}`
        axiosOptions.headers = {...axiosOptions.headers, Host: originalHost}
        axiosOptions.url = safeUrl.toString()
    } else {
        axiosOptions.url = url
    }

    const response = await axios.request(axiosOptions)
    return response
}

module.exports = {
    makeRequest
}