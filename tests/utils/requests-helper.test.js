/*eslint-disable no-undef */
const mockRequest = jest.fn(() => Promise.resolve({status: 200, data: 'ok'}))

jest.mock('axios', () => ({default: {request: (...args) => mockRequest(...args), defaults: {}}}))

const http = require('http')
const {default: axios} = require('axios')
const {makeRequest, pinnedLookup} = require('../../src/utils/requests-helper')

beforeEach(() => {
    mockRequest.mockClear()
})

describe('makeRequest with SSRF validation', () => {
    test('keeps the original url so TLS sni and certificate checks still work', async () => {
        await makeRequest('http://8.8.8.8/hook', {method: 'POST', data: {a: 1}, validateSsrf: true})
        const options = mockRequest.mock.calls[0][0]
        expect(options.url).toBe('http://8.8.8.8/hook')
        expect(options.headers?.Host).toBe(undefined)
    })

    test('refuses to follow redirects and treats 3xx as an error', async () => {
        await makeRequest('http://8.8.8.8/hook', {validateSsrf: true})
        const options = mockRequest.mock.calls[0][0]
        expect(options.maxRedirects).toBe(0)
        expect(options.validateStatus(200)).toBe(true)
        expect(options.validateStatus(204)).toBe(true)
        expect(options.validateStatus(302)).toBe(false)
        expect(options.validateStatus(307)).toBe(false)
        expect(options.validateStatus(500)).toBe(false)
    })

    test('caps the body size and the time', async () => {
        await makeRequest('http://8.8.8.8/hook', {validateSsrf: true})
        const options = mockRequest.mock.calls[0][0]
        expect(options.maxContentLength).toBe(1024 * 1024)
        expect(options.maxBodyLength).toBe(1024 * 1024)
        expect(options.timeout).toBe(5000)
    })

    test('an environment proxy cannot take the request off the pinned agents', async () => {
        await makeRequest('http://8.8.8.8/hook', {validateSsrf: true})
        expect(mockRequest.mock.calls[0][0].proxy).toBe(false)
    })

    test('the request carries the deadline signal', async () => {
        await makeRequest('http://8.8.8.8/hook', {validateSsrf: true})
        expect(mockRequest.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal)
    })

    test('a caller cannot override the egress limits', async () => {
        await makeRequest('http://8.8.8.8/hook', {validateSsrf: true, maxRedirects: 5, maxContentLength: -1, proxy: {host: 'evil'}})
        const options = mockRequest.mock.calls[0][0]
        expect(options.maxRedirects).toBe(0)
        expect(options.maxContentLength).toBe(1024 * 1024)
        expect(options.proxy).toBe(false)
    })

    test('a caller-supplied timeout is kept', async () => {
        await makeRequest('http://8.8.8.8/hook', {validateSsrf: true, timeout: 1500})
        expect(mockRequest.mock.calls[0][0].timeout).toBe(1500)
    })

    test('the agents pin the resolved address', async () => {
        await makeRequest('http://8.8.8.8/hook', {validateSsrf: true})
        const options = mockRequest.mock.calls[0][0]
        const lookup = options.httpsAgent.options.lookup
        expect(typeof lookup).toBe('function')
        const answer = await new Promise((resolve, reject) => lookup('8.8.8.8', {}, (err, address, family) => err ? reject(err) : resolve({address, family})))
        expect(answer).toEqual({address: '8.8.8.8', family: 4})
    })

    test('an IPv6 host is pinned with family 6', async () => {
        await makeRequest('http://[2001:4860:4860::8888]/hook', {validateSsrf: true})
        const lookup = mockRequest.mock.calls[0][0].httpAgent.options.lookup
        const answer = await new Promise((resolve, reject) => lookup('[2001:4860:4860::8888]', {}, (err, address, family) => err ? reject(err) : resolve({address, family})))
        expect(answer).toEqual({address: '2001:4860:4860::8888', family: 6})
    })

    test('the per-request agents are destroyed when the request settles', async () => {
        //http.Agent exposes no `destroyed` flag, and https.Agent inherits `destroy` from http.Agent.prototype, so
        //one spy on that prototype sees both agents (checked on Node 24 on 2026-09-23)
        const destroy = jest.spyOn(http.Agent.prototype, 'destroy')
        try {
            await makeRequest('http://8.8.8.8/hook', {validateSsrf: true})
            expect(destroy).toHaveBeenCalledTimes(2)
        } finally {
            destroy.mockRestore()
        }
    })

    test('a private target is refused before any request is made', async () => {
        await expect(makeRequest('http://169.254.169.254/latest/meta-data/', {validateSsrf: true})).rejects.toThrow('SSRF blocked')
        expect(mockRequest).not.toHaveBeenCalled()
    })

    test('a request without validation is left alone apart from the default timeout and the shared agents', async () => {
        await makeRequest('http://example.com/x', {method: 'GET'})
        const options = mockRequest.mock.calls[0][0]
        expect(options.url).toBe('http://example.com/x')
        expect(options.maxRedirects).toBe(undefined)
        expect(options.timeout).toBe(5000)
        expect(options.httpAgent).toBeDefined()
        expect(options.httpsAgent).toBeDefined()
    })

    test('requiring the helper does not mutate the axios singleton', () => {
        //reflector-shared and the connectors share this process-wide object
        expect(axios.defaults.httpAgent).toBe(undefined)
        expect(axios.defaults.httpsAgent).toBe(undefined)
    })
})

describe('pinnedLookup', () => {
    //8.8.8.8, not 203.0.113.5: after Step 3a the TEST-NET-3 range is private, and a pinned private address is refused
    test('answers the all:true form with a single record', done => {
        pinnedLookup('8.8.8.8')('example.com', {all: true}, (err, result) => {
            expect(err).toBe(null)
            expect(result).toEqual([{address: '8.8.8.8', family: 4}])
            done()
        })
    })

    test('answers the two-argument form', done => {
        pinnedLookup('8.8.8.8')('example.com', (err, address, family) => {
            expect(err).toBe(null)
            expect(address).toBe('8.8.8.8')
            expect(family).toBe(4)
            done()
        })
    })

    test('refuses a private pinned address', done => {
        pinnedLookup('127.0.0.1')('example.com', {}, err => {
            expect(err.message).toContain('SSRF blocked')
            done()
        })
    })
})

describe('a validated request keeps only the caller options that cannot bypass the limits', () => {
    test('options that would leave the pinned agents or the body cap are dropped', async () => {
        const callerSignal = new AbortController().signal
        const callerLookup = jest.fn()
        await makeRequest('http://8.8.8.8/hook', {
            validateSsrf: true,
            method: 'POST',
            headers: {'x-test': '1'},
            data: {a: 1},
            timeout: 1500,
            httpVersion: 2,
            http2Options: {},
            transport: {request: jest.fn()},
            socketPath: '/var/run/docker.sock',
            responseType: 'stream',
            lookup: callerLookup,
            signal: callerSignal,
            httpAgent: new http.Agent(),
            baseURL: 'http://10.0.0.1/',
            beforeRedirect: jest.fn()
        })
        const options = mockRequest.mock.calls[0][0]
        expect(Object.keys(options).sort()).toEqual([
            'data', 'headers', 'httpAgent', 'httpsAgent', 'maxBodyLength', 'maxContentLength', 'maxRedirects', 'method',
            'proxy', 'signal', 'timeout', 'url', 'validateStatus'
        ])
        expect(options.method).toBe('POST')
        expect(options.headers).toEqual({'x-test': '1'})
        expect(options.data).toEqual({a: 1})
        expect(options.timeout).toBe(1500)
        expect(options.signal).not.toBe(callerSignal)
        expect(options.httpAgent.options.lookup).not.toBe(callerLookup)
    })

    test('a budget that is not a finite positive number falls back to the default', async () => {
        for (const timeout of [0, -1, NaN, Infinity, '1000', null]) {
            mockRequest.mockClear()
            await makeRequest('http://8.8.8.8/hook', {validateSsrf: true, timeout})
            expect(mockRequest.mock.calls[0][0].timeout).toBe(5000)
        }
    })

    test('a request without validation still passes the caller options through', async () => {
        await makeRequest('http://example.com/x', {responseType: 'stream', timeout: 0})
        const options = mockRequest.mock.calls[0][0]
        expect(options.responseType).toBe('stream')
        expect(options.timeout).toBe(0)
    })
})
