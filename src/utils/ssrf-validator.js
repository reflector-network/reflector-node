//This is a deliberate mirror of node-orchestrator/utils/ssrf-validator.js. The two repositories keep their own copy,
//as they do for the WebSocket channel code; a change here has to be made there as well.
const dns = require('dns')
const net = require('net')

/**
 * Check if an IPv4 address is in a private or reserved range
 * @param {string} ip - IPv4 address
 * @returns {boolean}
 */
function isPrivateIPv4(ip) {
    const [a, b, c] = ip.split('.').map(Number)
    return (
        a === 0 //this network
        || a === 10 //private
        || a === 127 //loopback
        || (a === 100 && b >= 64 && b <= 127) //carrier-grade NAT, routable to an operator's own infrastructure
        || (a === 172 && b >= 16 && b <= 31) //private
        || (a === 192 && b === 0 && c === 0) //IETF protocol assignments
        || (a === 192 && b === 0 && c === 2) //TEST-NET-1
        || (a === 192 && b === 168) //private
        || (a === 198 && (b === 18 || b === 19)) //benchmarking
        || (a === 198 && b === 51 && c === 100) //TEST-NET-2
        || (a === 203 && b === 0 && c === 113) //TEST-NET-3
        || (a === 169 && b === 254) //link-local, and the cloud metadata service at 169.254.169.254
        || a >= 224 //multicast and reserved, up to and including 255.255.255.255
    )
}

/**
 * Expand an IPv6 address to its sixteen bytes, resolving `::` and a trailing dotted quad.
 * @param {string} ip - IPv6 address, already known to be well formed
 * @returns {number[]|null} sixteen bytes, or null when the address cannot be expanded
 */
function toIPv6Bytes(ip) {
    const halves = ip.toLowerCase().split('::')
    if (halves.length > 2)
        return null
    const bytesOf = (groups) => {
        const bytes = []
        for (const group of groups) {
            if (!group)
                continue
            if (group.indexOf('.') >= 0) { //a trailing dotted quad, as in ::ffff:127.0.0.1
                const quad = group.split('.').map(Number)
                if (quad.length !== 4 || quad.some(part => !Number.isInteger(part) || part < 0 || part > 255))
                    return null
                bytes.push(...quad)
                continue
            }
            const value = parseInt(group, 16)
            if (!Number.isInteger(value) || value < 0 || value > 0xffff)
                return null
            bytes.push(value >> 8, value & 0xff)
        }
        return bytes
    }
    const head = bytesOf(halves[0].split(':'))
    const tail = halves.length === 2 ? bytesOf(halves[1].split(':')) : []
    if (head === null || tail === null)
        return null
    const gap = 16 - head.length - tail.length
    if (gap < 0 || (gap > 0 && halves.length !== 2))
        return null
    return [...head, ...new Array(gap).fill(0), ...tail]
}

/**
 * Check if an IPv6 address is private or reserved, including the forms that carry an IPv4 address inside them
 * @param {string} ip - IPv6 address
 * @returns {boolean}
 */
function isPrivateIPv6(ip) {
    const b = toIPv6Bytes(ip)
    if (b === null)
        return true //an address this code cannot account for is not one it may approve
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80)
        return true //fe80::/10 link-local
    if ((b[0] & 0xfe) === 0xfc)
        return true //fc00::/7 unique local
    if (b[0] === 0xff)
        return true //ff00::/8 multicast
    if (b[0] === 0x20 && b[1] === 0x02)
        return isPrivateIPv4(b.slice(2, 6).join('.')) //2002::/16 6to4 carries its IPv4 address in the next four bytes
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b)
        return isPrivateIPv4(b.slice(12, 16).join('.')) //64:ff9b::/96 NAT64
    const prefix = b.slice(0, 10).every(byte => byte === 0)
    if (prefix && b[10] === 0xff && b[11] === 0xff)
        return isPrivateIPv4(b.slice(12, 16).join('.')) //::ffff:0:0/96 IPv4-mapped
    //::ffff:0:0:0/96 IPv4-translated (RFC 2765, SIIT): the kernel never maps it, but a translator in front of the host
    //carries it to the IPv4 address inside, so it is judged by that address like the mapped form
    if (b.slice(0, 8).every(byte => byte === 0) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0)
        return isPrivateIPv4(b.slice(12, 16).join('.'))
    if (prefix && b[10] === 0 && b[11] === 0) {
        //:: unspecified, ::1 loopback, and the deprecated ::/96 IPv4-compatible range
        const embedded = b.slice(12, 16)
        if (embedded.every(byte => byte === 0) || (embedded[0] === 0 && embedded[1] === 0 && embedded[2] === 0 && embedded[3] === 1))
            return true
        return isPrivateIPv4(embedded.join('.'))
    }
    return false
}

/**
 * Check if an IP address is private or reserved
 * @param {string} ip - IPv4 or IPv6 address
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
 * Strips the brackets the URL parser keeps around an IPv6 literal, so the value can be checked with net.isIP.
 * `new URL('http://[::1]/').hostname` is the six-character string "[::1]", which net.isIP rejects.
 * @param {string} hostname - URL hostname
 * @returns {string}
 */
function unbracketHost(hostname) {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

//the rules a node applies to the gateway list it routes through, kept identical to the node's copy so the orchestrator
//refuses exactly the lists every node would refuse. The probe of /validate-gateways still goes through
//validateRequestUrl and resolveAndValidate below, which add the resolved-address check at request time
const maxGatewayUrls = 10
const maxGatewayUrlLength = 2048

/**
 * Validates one gateway URL at config time. A gateway receives this node's static x-gateway-validation token, so
 * embedded credentials are refused outright, and an explicit private address is refused too.
 * @param {string} urlString - gateway url
 * @returns {string} the url with trailing slashes removed
 */
function validateGatewayUrl(urlString) {
    if (typeof urlString !== 'string' || !urlString || urlString.length > maxGatewayUrlLength)
        throw new Error(`Gateway URL must be a non-empty string of at most ${maxGatewayUrlLength} characters`)
    const parsed = new URL(urlString)
    //http is allowed: the dashboard and the gateway image are http only, and
    //https-only gateways are not required
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error(`Gateway URL must use http or https, got ${parsed.protocol}`)
    if (parsed.username || parsed.password)
        throw new Error('Gateway URL must not contain user information')
    //a bare `?` or `#` leaves search and hash empty but stays in the url, and would turn the path appended later into a
    //query string or a fragment
    if (parsed.search || parsed.hash || /[?#]/.test(parsed.href))
        throw new Error('Gateway URL must not contain a query string or a fragment')
    const host = unbracketHost(parsed.hostname)
    if (net.isIP(host) && isPrivateIP(host))
        throw new Error(`Gateway URL points at a private address: ${host}`)
    //the parsed form, not the raw string: the parser drops tabs, newlines and surrounding spaces the raw string would
    //carry into every request url, and lower-cases the host
    return parsed.href.replace(/\/+$/, '')
}

/**
 * Parse a subscriber-supplied webhook URL and refuse anything that is not plain http(s). Every rejection carries a
 * safeMessage, so a caller always has a reason it can echo without describing the network it just looked at.
 * @param {string} urlString - url to validate
 * @returns {URL}
 */
function validateWebhookUrl(urlString) {
    let parsed
    try {
        parsed = new URL(urlString)
    } catch (e) {
        //a bare TypeError from the parser carried no safeMessage, which left the caller with a generic string
        const error = new Error('Invalid webhook url')
        error.safeMessage = 'Invalid url'
        throw error
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        const error = new Error(`Blocked URL scheme: ${parsed.protocol}`)
        error.safeMessage = 'Blocked URL scheme'
        throw error
    }
    //there is no empty-hostname case to check: for http(s) the WHATWG parser refuses an empty host outright
    //(`new URL('http://')` throws), so a branch for it could not be reached
    return parsed
}

/**
 * The error an aborted deadline reports. The reason the signal carries is preferred when it has a safeMessage, so the
 * caller sees why the budget ended rather than a generic cancellation; otherwise the error always carries one.
 * @param {AbortSignal} signal - aborted signal
 * @returns {Error}
 */
function abortReason(signal) {
    //the property is tested, not `instanceof Error`: an abort without a reason leaves a DOMException, which is an Error
    //in Node but carries no safeMessage for the caller to echo
    if (signal.reason?.safeMessage)
        return signal.reason
    const error = new Error('Host resolution aborted')
    error.safeMessage = 'Request timed out'
    return error
}

//dns.lookup runs on the libuv threadpool (4 threads by default) and cannot be cancelled, so a lookup abandoned at its
//deadline keeps its thread until the resolver answers or the OS gives up. A resolver that never answers
//could otherwise fill the pool and stall every other dns, fs and crypto call in the process. Capping lookups in flight
//at 2 keeps at least 2 of the 4 threads free for that other work, whatever the resolver does.
const maxLookupsInFlight = 2
let lookupsInFlight = 0

/**
 * Resolve a hostname without outliving the caller's deadline. dns.promises.lookup takes no signal, so the only way to
 * bound it is to stop waiting for it: the lookup is left to settle on its own and its answer discarded. Sharing the
 * caller's signal keeps resolution, connect and read on one budget rather than giving each its own timer.
 * At most maxLookupsInFlight lookups run at once; one more is refused at once rather than queued.
 * @param {string} host - hostname to resolve
 * @param {AbortSignal} [signal] - deadline shared with the rest of the request
 * @returns {Promise<string>} resolved address
 */
function lookupWithin(host, signal) {
    if (signal?.aborted)
        return Promise.reject(abortReason(signal))
    if (lookupsInFlight >= maxLookupsInFlight) {
        //refused rather than queued: a queue would only move the wait, and the host is left out of both messages
        const error = new Error('Host lookup refused: too many lookups in flight')
        error.safeMessage = 'Too many host lookups in progress'
        return Promise.reject(error)
    }
    const pending = dns.promises.lookup(host, {family: 0})
    //counted once the lookup has started, so a synchronous throw cannot leak a slot. The slot is released when the
    //lookup itself settles, never when the deadline gives up on it: an abandoned lookup still holds its thread
    lookupsInFlight++
    const lookup = pending.finally(() => lookupsInFlight--).then(result => result.address)
    if (!signal)
        return lookup
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        signal.addEventListener('abort', onAbort, {once: true})
        lookup.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
}

/**
 * Resolve the host and refuse a private or reserved answer. An IP literal is checked directly, which covers a
 * bracketed IPv6 literal without reconstructing the url.
 * @param {string} urlString - url to validate
 * @param {{signal: AbortSignal}} [options] - deadline to resolve within
 * @returns {Promise<{url: URL, resolvedIp: string}>}
 */
async function resolveAndValidate(urlString, options = {}) {
    const parsed = validateWebhookUrl(urlString)
    const host = unbracketHost(parsed.hostname)
    const ip = net.isIP(host) ? host : await lookupWithin(host, options.signal)
    if (isPrivateIP(ip)) {
        const error = new Error(`SSRF blocked: ${host} resolved to private IP ${ip}`)
        error.safeMessage = 'Host resolves to a private address'
        throw error
    }
    return {url: parsed, resolvedIp: ip}
}

module.exports = {validateWebhookUrl, resolveAndValidate, isPrivateIP, unbracketHost, toIPv6Bytes, validateGatewayUrl, maxGatewayUrls}
