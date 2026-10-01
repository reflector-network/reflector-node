const https = require('https')
const http = require('http')
const net = require('net')
const {default: axios} = require('axios')
const {resolveAndValidate, isPrivateIP} = require('./ssrf-validator')

const defaultAgentOptions = {keepAlive: true, maxSockets: 50, noDelay: true}

//the shared agents are passed explicitly on every request rather than assigned to axios.defaults: that object is a
//process-wide singleton @reflector/reflector-shared and the connectors share
const httpAgent = new http.Agent(defaultAgentOptions)
const httpsAgent = new https.Agent(defaultAgentOptions)

//egress limits for validated targets (subscriber webhooks and operator-configured gateways)
const maxResponseSize = 1024 * 1024
const defaultRequestTimeout = 5000
//the only caller options a validated request keeps. Anything else could take it off the pinned agents or around the
//limits: httpVersion 2 and transport bypass the agents, socketPath the address, responseType 'stream' the body cap
const validatedRequestOptions = ['method', 'headers', 'data', 'timeout']

/**
 * Builds the error a deadline aborts with. The reason travels on the signal, so it has to carry a safeMessage of its
 * own: it is what the caller is told once axios has discarded its own error in favour of a cancellation.
 * @param {string} message - internal message
 * @param {string} safeMessage - reason that is safe to echo to the caller
 * @returns {Error}
 */
function timeoutError(message, safeMessage) {
    const error = new Error(message)
    error.safeMessage = safeMessage
    return error
}

/**
 * Carries the safe reason across the axios boundary. axios re-wraps a socket-level failure, so the safeMessage set by
 * the pinned lookup arrives on `error.cause` rather than on the error itself, and a cancelled request reports axios'
 * own generic message instead of the reason the deadline was armed with.
 * @param {Error} error - error raised by the request
 * @param {AbortSignal} signal - deadline signal for this request
 * @returns {Error}
 */
function asSafeError(error, signal) {
    if (error.safeMessage)
        return error
    if (signal.aborted && signal.reason instanceof Error && signal.reason.safeMessage)
        return signal.reason
    if (error.cause?.safeMessage)
        error.safeMessage = error.cause.safeMessage
    return error
}

/**
 * Builds a dns lookup that always answers with the address the SSRF validator approved, so a second resolution between
 * validation and connect cannot land on a private range. The hostname stays in the URL, which keeps TLS sni and
 * certificate verification working - rewriting the host to the IP would break both.
 * @param {string} resolvedIp - validated address
 * @returns {Function} lookup(hostname, options, callback) in the dns.lookup shape
 */
function pinnedLookup(resolvedIp) {
    const family = net.isIPv6(resolvedIp) ? 6 : 4
    return function lookup(hostname, options, callback) {
        const done = typeof options === 'function' ? options : callback
        if (isPrivateIP(resolvedIp))
            return done(timeoutError(`SSRF blocked: ${hostname} pinned to private IP ${resolvedIp}`, 'Host resolves to a private address'))
        //Node >= 20 calls the agent lookup with {all: true}
        if (options && typeof options !== 'function' && options.all)
            return done(null, [{address: resolvedIp, family}])
        return done(null, resolvedIp, family)
    }
}

/**
 * @param {string} url - request url
 * @param {any} [options] - request options; `validateSsrf` turns on address pinning, the deadline and the egress limits
 * @returns {Promise<any>}
 * @protected
 */
async function makeRequest(url, options = {}) {
    const {validateSsrf, ...axiosOptions} = options

    axiosOptions.url = url
    if (axiosOptions.timeout === undefined)
        axiosOptions.timeout = defaultRequestTimeout

    if (!validateSsrf) {
        if (axiosOptions.httpAgent === undefined)
            axiosOptions.httpAgent = httpAgent
        if (axiosOptions.httpsAgent === undefined)
            axiosOptions.httpsAgent = httpsAgent
        return await axios.request(axiosOptions)
    }

    const request = {url}
    for (const key of validatedRequestOptions)
        if (axiosOptions[key] !== undefined)
            request[key] = axiosOptions[key]
    //0 means "no timeout" to axios but would fire the deadline at once here, so only a finite positive budget is kept
    if (!(Number.isFinite(request.timeout) && request.timeout > 0))
        request.timeout = defaultRequestTimeout

    //axios' `timeout` is a socket-inactivity timer, not a deadline: a host that trickles one byte at a time resets it
    //for as long as it likes, and dns.promises.lookup is not covered by it at all. This wall-clock deadline is armed
    //before the lookup, so resolution, connect and read share one budget
    const controller = new AbortController()
    const deadline = setTimeout(
        () => controller.abort(timeoutError(`Request exceeded ${request.timeout}ms`, 'Request timed out')),
        request.timeout
    )
    let requestAgents = null
    try {
        const {resolvedIp} = await resolveAndValidate(url, {signal: controller.signal})
        const lookup = pinnedLookup(resolvedIp)
        //one agent pair per request: the pinned lookup belongs to this target only, so it must not reach the shared
        //agents above. They are destroyed in the finally below - on the subscriptions path this runs once per
        //notification per webhook per tick, and each https.Agent carries its own TLS session cache
        request.httpAgent = new http.Agent({...defaultAgentOptions, keepAlive: false, lookup})
        request.httpsAgent = new https.Agent({...defaultAgentOptions, keepAlive: false, lookup})
        requestAgents = [request.httpAgent, request.httpsAgent]
        request.signal = controller.signal
        //the limits are assigned after the caller's options are copied, so a caller cannot widen them
        request.maxRedirects = 0 //a redirect target is chosen by the remote host and was never validated
        request.validateStatus = status => status >= 200 && status < 300 //3xx is an error, not a hop to follow
        request.maxContentLength = maxResponseSize
        request.maxBodyLength = maxResponseSize
        //an HTTP_PROXY in the environment would connect to the proxy instead of the target, which takes the request
        //off the agents above and the pinned lookup with them - the proxy would resolve the hostname itself - so it
        //is deliberately ignored here
        request.proxy = false
        return await axios.request(request)
    } catch (e) {
        throw asSafeError(e, controller.signal)
    } finally {
        clearTimeout(deadline)
        if (requestAgents)
            for (const agent of requestAgents)
                agent.destroy()
    }
}

/**
 * The part of a url that may be written to a log. A subscriber's webhook url can carry credentials, and its path and
 * query often carry a token, so only the host is kept - the same rule the orchestrator applies to gateway probes.
 * @param {string} url - request url
 * @returns {string} host and port, or a placeholder when the url does not parse
 */
function loggableHost(url) {
    try {
        return new URL(url).host || 'no host'
    } catch (e) {
        return 'invalid url'
    }
}

module.exports = {
    makeRequest,
    pinnedLookup,
    loggableHost
}
