/*eslint-disable no-undef */
jest.unmock('../src/logger')

//the real logger writes through rotating-file-stream; swapping only that layer for memory sinks keeps the log lines in
//memory while logger.js itself - its serializers and redact paths - runs as it ships. Loading logger.js still creates
//./home/logs/metrics, as every test that loads the real logger does
const mockSinks = []
jest.mock('rotating-file-stream', () => ({
    createStream: () => {
        const sink = {
            chunks: [],
            write(chunk) {
                sink.chunks.push(chunk.toString())
            }
        }
        mockSinks.push(sink)
        return sink
    }
}))

const logger = require('../src/logger')

/**
 * @returns {string} everything written to combined.log so far; logger.js opens error.log, combined.log, then metrics.log
 */
function combined() {
    return mockSinks[1].chunks.join('')
}

describe('secrets never reach a log line', () => {
    test('secret keys are censored up to four levels deep', () => {
        logger.info({
            msg: 'config',
            clusterSecret: 'plain-secret-1',
            config: {secret: 'plain-secret-2', nested: {apiKey: 'plain-secret-3', deeper: {gatewayValidationKey: 'plain-secret-4'}}}
        })
        const written = combined()
        for (const value of ['plain-secret-1', 'plain-secret-2', 'plain-secret-3', 'plain-secret-4'])
            expect(written).not.toContain(value)
        expect(written).toContain('[redacted]')
    })

    test('an axios error keeps its status and host, and loses its headers, body and full url', () => {
        const err = new Error('Request failed with status code 500')
        err.isAxiosError = true
        err.config = {url: 'https://gw.example.com/path/token123?x=1', headers: {'x-gateway-validation': 'plain-secret-5'}, data: 'request body'}
        err.response = {status: 500}
        logger.error({err, msg: 'gateway failed'})
        const written = combined()
        expect(written).not.toContain('plain-secret-5')
        expect(written).not.toContain('token123')
        expect(written).not.toContain('request body')
        expect(written).toContain('"status":500')
    })
})

//an rpc provider key often lives in the url path (https://provider/<key>), where the query-key pattern never looks: every
//url that reaches a log line keeps its scheme, host and port only
describe('a url reaches a log line as its scheme, host and port only', () => {
    const {makeServerRequest} = require('../src/utils/rpc-helper')
    const {redactString, safeUrl} = require('../src/utils/log-redaction')
    const keyedUrl = 'https://rpc.example/v1/SECRETKEY123/'

    /**
     * @param {string} url - request url
     * @returns {Error} an axios-shaped request failure, as the sdk's rpc client throws it
     */
    function axiosFailure(url) {
        const err = new Error(`Request failed with status code 403 for ${url}`)
        err.isAxiosError = true
        err.config = {url, method: 'post', headers: {}, data: '{"jsonrpc":"2.0"}'}
        err.response = {status: 403, config: {url}}
        return err
    }

    test('safeUrl keeps the scheme, host and port, and drops userinfo, path, query and fragment', () => {
        expect(safeUrl(keyedUrl)).toBe('https://rpc.example')
        expect(safeUrl('https://user:pass@rpc.example:8443/v1/SECRETKEY123/?key=abc#frag')).toBe('https://rpc.example:8443')
        expect(safeUrl('wss://orchestrator.example/ws/SECRETKEY123')).toBe('wss://orchestrator.example')
        expect(safeUrl('not a url')).toBeUndefined()
        expect(safeUrl(undefined)).toBeUndefined()
    })

    test('a url inside any logged string loses everything after its host', () => {
        expect(redactString(`request to ${keyedUrl} failed`)).toBe('request to https://rpc.example failed')
        expect(redactString('POST https://user:pass@rpc.example:8443/v1/SECRETKEY123/?key=abc#frag timed out'))
            .toBe('POST https://rpc.example:8443 timed out')
        expect(redactString('ws://node.example:30347/SECRETKEY123 closed')).toBe('ws://node.example:30347 closed')
        //the ipv4 middle octets stay masked on what is left
        expect(redactString('http://10.1.2.3:8000/v1/SECRETKEY123')).toBe('http://10.***.***.3:8000')
        //stack frames are file urls and keep their paths
        expect(redactString('at file:///app/src/index.js:10:5')).toBe('at file:///app/src/index.js:10:5')
    })

    test('a failing rpc url with a key in its path is logged as its host, in every retry and in the final error', async () => {
        const before = combined().length
        const error = await makeServerRequest([keyedUrl], () => Promise.reject(axiosFailure(keyedUrl))).catch(e => e)
        logger.error({err: error, msg: 'RPC request failed'})
        const written = combined().slice(before)

        expect(error.cause.errAggr.map(({url}) => url)).toEqual(['https://rpc.example'])
        expect(written).not.toContain('SECRETKEY123')
        expect(written).not.toContain('/v1')
        //two retry warnings and the final error, each naming the host
        const lines = written.split('\n').filter(Boolean).map(line => JSON.parse(line))
        expect(lines.map(line => [line.level, line.msg])).toEqual([
            ['warn', 'RPC call failed, retrying'],
            ['warn', 'RPC call failed, retrying'],
            ['error', 'RPC request failed']
        ])
        expect(lines[0].err[0].url).toBe('https://rpc.example')
        expect(lines[1].err[0].url).toBe('https://rpc.example')
        expect(lines[0].err[0].err.message).toBe('Request failed with status code 403 for https://rpc.example')
    })

    test('an axios-shaped error keeps its host only', () => {
        const before = combined().length
        logger.error({err: axiosFailure(keyedUrl), msg: 'rpc failed'})
        const written = combined().slice(before)

        expect(written).not.toContain('SECRETKEY123')
        expect(written).toContain('"url":"https://rpc.example"')
        expect(written).toContain('Request failed with status code 403 for https://rpc.example')
    })
})
