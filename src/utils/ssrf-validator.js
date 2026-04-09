const dns = require('dns')
const net = require('net')

/**
 * Check if an IPv4 address is in a private/reserved range
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts
    return (
        a === 0
        || a === 10
        || a === 127
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 169 && b === 254)
    )
}

/**
 * Check if an IPv6 address is private/reserved
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIPv6(ip) {
    const normalized = ip.toLowerCase()
    if (normalized === '::1' || normalized === '::')
        return true
    //fe80::/10 (link-local), fc00::/7 (ULA)
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd'))
        return true
    //IPv6-mapped IPv4 (::ffff:x.x.x.x)
    const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4Mapped)
        return isPrivateIPv4(v4Mapped[1])
    return false
}

/**
 * Check if an IP address is private/reserved
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIP(ip) {
    if (net.isIPv4(ip))
        return isPrivateIPv4(ip)
    if (net.isIPv6(ip))
        return isPrivateIPv6(ip)
    return false
}

/**
 * Validate webhook URL scheme (synchronous, for parse-time validation)
 * @param {string} urlString
 * @returns {URL}
 */
function validateWebhookUrl(urlString) {
    const parsed = new URL(urlString)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error(`Blocked URL scheme: ${parsed.protocol}`)
    if (!parsed.hostname)
        throw new Error('Empty hostname')
    return parsed
}

/**
 * Resolve hostname and validate the resolved IP is not private (async, for request-time SSRF protection)
 * @param {string} urlString
 * @returns {Promise<{url: URL, resolvedIp: string}>}
 */
async function resolveAndValidate(urlString) {
    const parsed = validateWebhookUrl(urlString)
    let ip
    if (net.isIP(parsed.hostname)) {
        ip = parsed.hostname
    } else {
        const result = await dns.promises.lookup(parsed.hostname, {family: 0})
        ip = result.address
    }
    if (isPrivateIP(ip))
        throw new Error(`SSRF blocked: ${parsed.hostname} resolved to private IP ${ip}`)
    return {url: parsed, resolvedIp: ip}
}

module.exports = {validateWebhookUrl, resolveAndValidate, isPrivateIP}
