const https = require('https')
const http = require('http')
const {default: axios} = require('axios')
const {SocksProxyAgent} = require('socks-proxy-agent')
const logger = require('../logger')

const defaultAgentOptions = {keepAlive: true, maxSockets: 50, noDelay: true}

let proxyAgents = null

const httpAgent = new http.Agent(defaultAgentOptions)
axios.defaults.httpAgent = httpAgent

const httpsAgent = new https.Agent(defaultAgentOptions)
axios.defaults.httpsAgent = httpsAgent

function createProxyAgent(proxyConnectionString) {
    if (!proxyConnectionString)
        return null
    if (!proxyConnectionString || !proxyConnectionString.startsWith('socks'))
        throw new Error(`Invalid proxy uri ${proxyConnectionString}`)
    const socksAgent = new SocksProxyAgent(proxyConnectionString, defaultAgentOptions)
    return socksAgent
}

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
    requestOptions.httpAgent = requestOptions.httpsAgent = getProxyAgent()
    const response = await axios.request(requestOptions)
    return response
}

function setProxy(proxyConnectionSting) {
    if (!proxyConnectionSting) {
        proxyAgents = null
        return
    }

    const proxies = []
    if (!Array.isArray(proxyConnectionSting))
        proxyConnectionSting = [proxyConnectionSting]

    for (const p of proxyConnectionSting) {
        try {
            proxies.push(createProxyAgent(p))
        } catch (err) {
            logger.error({err}, 'Failed to create proxy agent')
        }
    }
    if (proxies.length === 0) {
        proxyAgents = null
        return
    }

    proxyAgents = proxies
}

function getProxyAgent() {
    if (!proxyAgents) //no proxies
        return undefined

    if (proxyAgents.length === 1) //single proxy, no need to rotate
        return proxyAgents[0]

    const index = Math.floor(Math.random() * length)

    return proxyAgents[index]
}

module.exports = {
    makeRequest,
    setProxy
}