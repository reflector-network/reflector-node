const net = require('net')
const path = require('path')

//the logger's string redaction, in a module of its own so that code which puts free text into a log field other than
//msg and err can apply the same rules
const basePath = path.resolve(path.resolve(process.cwd()), '..') + path.sep

//Stellar secret seeds, RSA private keys (PEM, and the base64 DER the cluster config carries as clusterSecret), http
//credentials, api keys in a query string and IPv6 addresses never reach a log file, and IPv4 addresses keep their middle
//octets masked. These are node-orchestrator logger-cleanup.js's patterns plus the DER form. A url keeps
//its scheme, host and port only: rpc and data providers put api keys in the path (https://provider/<key>) as often as
//in the query, so no part of the path is safe to keep
const seedPattern = /\bS[A-Z2-7]{55}\b/g
const rsaPemPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const rsaDerPattern = /\bMII[A-Za-z0-9+/]{60,}={0,2}/g
const credentialsPattern = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi
const apiKeyQueryPattern = /([?&](?:api[-_]?key|apikey|access[-_]?key|access[-_]?token|auth[-_]?token|token|secret|key)=)[^&\s"']+/gi
//an http or websocket url: scheme, optional userinfo, the host and port, then whatever follows up to a blank or a quote.
//file urls - stack frames - keep their paths
const urlPattern = /\b((?:https?|wss?):\/\/)(?:[^\s/?#@"'<>`]*@)?([^\s/?#"'<>`]*)[^\s"'<>`]*/gi
const ipv4Pattern = /(\d+)\.(\d+)\.(\d+)\.(\d+)/g
const ipv6Candidate = /(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/g

/**
 * @param {string} address - ipv6 address
 * @returns {string} the address with everything between the first and last group masked
 */
function maskIpv6(address) {
    const parts = address.split(':')
    return `${parts[0]}:***:${parts[parts.length - 1]}`
}

/**
 * @param {string} [url] - request url
 * @returns {string|undefined} scheme, host and port only - no userinfo, path, query or fragment; undefined when it is
 * not a url
 */
function safeUrl(url) {
    if (typeof url !== 'string')
        return undefined
    try {
        const {protocol, host} = new URL(url)
        return `${protocol}//${host}`
    } catch (e) {
        return undefined
    }
}

/**
 * @param {string} value - log string
 * @returns {string} the string with secrets and network detail redacted
 */
function redactString(value) {
    return value
        .replaceAll(basePath, './')
        .replace(urlPattern, '$1$2')
        .replace(rsaPemPattern, '[redacted]')
        .replace(rsaDerPattern, '[redacted]')
        .replace(seedPattern, '[redacted]')
        .replace(credentialsPattern, '[redacted]')
        .replace(apiKeyQueryPattern, '$1[redacted]')
        .replace(ipv4Pattern, '$1.***.***.$4')
        .replace(ipv6Candidate, match => (net.isIPv6(match) ? maskIpv6(match) : match))
        .replaceAll('\\', '/')
}

module.exports = {redactString, safeUrl}
