/*eslint-disable no-undef */
//Drives the real axios http adapter against servers on loopback, so the limits are shown to hold on the wire and not
//only in the options object. Loopback is private, so the validator is told to approve a made-up name and pin it to
//127.0.0.1; everything after validation - the per-request agents, the pinned lookup, the deadline and the limits - is
//the real code. The made-up name has no DNS record, so a request only arrives if the pinned lookup answered it.
jest.mock('../../src/utils/ssrf-validator', () => ({
    ...jest.requireActual('../../src/utils/ssrf-validator'),
    resolveAndValidate: jest.fn(),
    isPrivateIP: jest.fn(() => false)
}))

const dns = require('dns')
const http = require('http')
const net = require('net')
const {resolveAndValidate} = require('../../src/utils/ssrf-validator')
const {makeRequest} = require('../../src/utils/requests-helper')

const pinnedName = 'webhook.test'
let systemLookup = null

beforeAll(() => {
    //the system resolver is the thing the pin replaces, so it may not answer for the made-up name - and refusing every
    //name keeps the tests off the network even when the pin is broken. An IP literal (the servers bind 127.0.0.1)
    //never leaves the process, so it is passed through
    const realLookup = dns.lookup
    systemLookup = jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => {
        if (net.isIP(hostname))
            return realLookup(hostname, options, callback)
        const done = typeof options === 'function' ? options : callback
        const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`)
        error.code = 'ENOTFOUND'
        process.nextTick(() => done(error))
    })
})

afterAll(() => {
    systemLookup.mockRestore()
})

/**
 * Starts a loopback server that records every request it sees
 * @param {Function} handler - (req, res) request handler
 * @returns {Promise<{server: http.Server, port: number, seen: string[], sockets: Set}>}
 */
function startServer(handler) {
    return new Promise(resolve => {
        const seen = []
        const sockets = new Set()
        const server = http.createServer((req, res) => {
            seen.push(`${req.method} ${req.url} host=${req.headers.host}`)
            handler(req, res)
        })
        server.on('connection', socket => {
            sockets.add(socket)
            socket.on('close', () => sockets.delete(socket))
        })
        server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port, seen, sockets}))
    })
}

/**
 * @param {{server: http.Server, sockets: Set}} target - server to stop
 * @returns {Promise<void>}
 */
function stopServer({server, sockets}) {
    for (const socket of sockets)
        socket.destroy()
    return new Promise(resolve => server.close(() => resolve()))
}

let target = null

beforeEach(() => {
    systemLookup.mockClear()
    resolveAndValidate.mockReset()
    resolveAndValidate.mockImplementation(url => Promise.resolve({url: new URL(url), resolvedIp: '127.0.0.1'}))
})

afterEach(async () => {
    if (target)
        await stopServer(target)
    target = null
})

describe('validated egress on the wire', () => {
    test('connects to the pinned address while keeping the original host', async () => {
        target = await startServer((req, res) => {
            let body = ''
            req.on('data', chunk => body += chunk)
            req.on('end', () => res.end(body))
        })
        const response = await makeRequest(`http://${pinnedName}:${target.port}/hook`, {method: 'POST', data: {a: 1}, validateSsrf: true})
        expect(response.status).toBe(200)
        expect(response.data).toEqual({a: 1})
        expect(target.seen).toEqual([`POST /hook host=${pinnedName}:${target.port}`])
        expect(resolveAndValidate).toHaveBeenCalledTimes(1)
        expect(systemLookup.mock.calls.map(([hostname]) => hostname)).not.toContain(pinnedName)
    })

    test('a 3xx is an error and its target is never requested', async () => {
        target = await startServer((req, res) => {
            res.writeHead(302, {location: '/internal'})
            res.end()
        })
        const error = await makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true}).catch(e => e)
        expect(error.response.status).toBe(302)
        expect(error.message).toBe('Request failed with status code 302')
        expect(target.seen).toEqual([`GET /hook host=${pinnedName}:${target.port}`])
    })

    test('a redirect to another host is not followed either', async () => {
        const internal = await startServer((req, res) => res.end('metadata'))
        try {
            target = await startServer((req, res) => {
                res.writeHead(307, {location: `http://127.0.0.1:${internal.port}/latest/meta-data/`})
                res.end()
            })
            await expect(makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true}))
                .rejects.toMatchObject({message: 'Request failed with status code 307'})
            expect(internal.seen).toEqual([])
        } finally {
            await stopServer(internal)
        }
    })

    test('a body over 1 MiB is refused and not echoed in the error', async () => {
        target = await startServer((req, res) => res.end('x'.repeat(1024 * 1024 + 1)))
        const error = await makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true}).catch(e => e)
        expect(error.message).toBe('maxContentLength size of 1048576 exceeded')
        expect(error.response).toBe(undefined)
    })

    test('a body of exactly 1 MiB is accepted', async () => {
        target = await startServer((req, res) => res.end('x'.repeat(1024 * 1024)))
        const response = await makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true})
        expect(response.data.length).toBe(1024 * 1024)
    })

    test('a host that trickles its answer is cut off at the wall-clock deadline', async () => {
        //axios' `timeout` is socket inactivity, so a byte every 50 ms would hold it open for as long as the host liked
        const timers = []
        target = await startServer((req, res) => {
            res.writeHead(200, {'content-type': 'text/plain'})
            timers.push(setInterval(() => res.write('.'), 50))
        })
        const start = Date.now()
        try {
            await expect(makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true, timeout: 300}))
                .rejects.toMatchObject({message: 'Request exceeded 300ms', safeMessage: 'Request timed out'})
        } finally {
            for (const timer of timers)
                clearInterval(timer)
        }
        const elapsed = Date.now() - start
        expect(elapsed).toBeGreaterThanOrEqual(250)
        expect(elapsed).toBeLessThan(1500)
    })

    test('an environment proxy is ignored', async () => {
        const proxy = await startServer((req, res) => res.end('proxied'))
        const saved = process.env.HTTP_PROXY
        process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
        try {
            target = await startServer((req, res) => res.end('direct'))
            const response = await makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true})
            expect(response.data).toBe('direct')
            expect(proxy.seen).toEqual([])
        } finally {
            if (saved === undefined)
                delete process.env.HTTP_PROXY
            else
                process.env.HTTP_PROXY = saved
            await stopServer(proxy)
        }
    })

    test('the connection is not kept alive after the request settles', async () => {
        target = await startServer((req, res) => res.end('ok'))
        await makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true})
        //the per-request agents are destroyed, so the server sees its only socket close
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(target.sockets.size).toBe(0)
    })

    test('the pinned address is checked again at connect time', async () => {
        const {isPrivateIP} = require('../../src/utils/ssrf-validator')
        isPrivateIP.mockImplementation(ip => ip === '127.0.0.1')
        try {
            target = await startServer((req, res) => res.end('ok'))
            await expect(makeRequest(`http://${pinnedName}:${target.port}/hook`, {validateSsrf: true}))
                .rejects.toMatchObject({safeMessage: 'Host resolves to a private address'})
            expect(target.seen).toEqual([])
        } finally {
            isPrivateIP.mockImplementation(() => false)
        }
    })
})
