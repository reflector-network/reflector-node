/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const ChannelTypes = require('../../../src/ws-server/channels/channel-types')

jest.mock('../../../src/domain/container', () => ({homeDir: null, settingsManager: null}))
jest.mock('../../../src/ws-server/nonce-manager', () => {
    const mockNonces = {}
    return {
        getNonce: jest.fn(type => mockNonces[type] || 0),
        setNonce: jest.fn((type, nonce) => {
            mockNonces[type] = nonce
        }),
        nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways', SET_TRACE: 'setTrace', LOGS: 'logs', LOG_FILE: 'logFile'},
        mockNonces
    }
})

const logger = require('../../../src/logger')
const container = require('../../../src/domain/container')
const nonceManager = require('../../../src/ws-server/nonce-manager')
const SetTraceHandler = require('../../../src/ws-server/handlers/set-trace-handler')
const LogsRequestHandler = require('../../../src/ws-server/handlers/logs-request-handler')
const LogFileRequestHandler = require('../../../src/ws-server/handlers/log-file-request-handler')

const own = Keypair.random()
const monitor = Keypair.random() //the monitoring key: a cluster node key that is not this node's
const outsider = Keypair.random()
let nonce = 1_700_000_000_000

/**
 * @returns {number} a nonce above every earlier one, as the dashboard's clock gives
 */
function nextNonce() {
    nonce += 1
    return nonce
}

/**
 * node-orchestrator server/middlewares.js buildRouteBinding, for a route without params
 * @param {string} route - route path without the leading slash
 * @param {object} query - query parameters other than the nonce
 * @param {number} n - request nonce
 * @returns {string}
 */
function binding(route, query, n) {
    return route + '?' + new URLSearchParams(sortObjectKeys({...query, nonce: n})).toString()
}

/**
 * Signs a payload as admin-dashboard does and node-orchestrator verifies it
 * @param {Keypair} kp - signer
 * @param {string|object} payload - signed payload
 * @returns {string} hex signature
 */
function signPayload(kp, payload) {
    const hash = createHash('sha256').update(`${kp.publicKey()}:${JSON.stringify(payload)}`, 'utf8').digest()
    return Buffer.from(kp.sign(hash)).toString('hex')
}

/**
 * A relayed GET, round-tripped through JSON as the websocket frame carries it
 * @param {Keypair} kp - signer
 * @param {string} route - signed route
 * @param {object} query - query parameters other than the nonce
 * @param {object} [extra] - unsigned fields the orchestrator adds beside the payload
 * @returns {object} the message
 */
function relayGet(kp, route, query = {}, extra = {}) {
    const payload = binding(route, query, nextNonce())
    return JSON.parse(JSON.stringify({data: {...extra, data: payload, signature: signPayload(kp, payload), pubkey: kp.publicKey()}}))
}

/**
 * A relayed SET_TRACE POST
 * @param {Keypair} kp - signer
 * @param {boolean} isTraceEnabled - signed value
 * @param {object} [query] - query parameters other than the nonce
 * @param {boolean} [unsignedCopy] - the bare value the orchestrator sends beside the payload for older nodes
 * @returns {object} the message
 */
function relayTrace(kp, isTraceEnabled, query = {}, unsignedCopy = isTraceEnabled) {
    const n = nextNonce()
    const payload = sortObjectKeys({isTraceEnabled, nonce: n, path: binding('logs/trace', query, n)})
    const message = {data: {isTraceEnabled: unsignedCopy, data: payload, signature: signPayload(kp, payload), pubkey: kp.publicKey()}}
    return JSON.parse(JSON.stringify(message))
}

let home

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-control-'))
    fs.mkdirSync(path.join(home, 'logs'))
    fs.writeFileSync(path.join(home, 'logs', 'combined.log'), 'line 1\nline 2\n')
    fs.writeFileSync(path.join(home, 'logs', 'error.log'), 'error line\n')
    fs.writeFileSync(path.join(home, 'logs', 'rotate.txt'), 'rotation')
    container.homeDir = home
    container.settingsManager = {
        appConfig: {publicKey: own.publicKey(), trace: true},
        config: {nodes: new Map([[own.publicKey(), {}], [monitor.publicKey(), {}]])},
        setTrace: jest.fn()
    }
    for (const key of Object.keys(nonceManager.mockNonces))
        delete nonceManager.mockNonces[key]
    logger.warn.mockClear()
})

afterEach(() => {
    fs.rmSync(home, {recursive: true, force: true})
})

describe('control-message handlers keep their channel policy', () => {
    test('orchestrator channel only, anonymous', () => {
        for (const Handler of [SetTraceHandler, LogsRequestHandler, LogFileRequestHandler]) {
            const handler = new Handler()
            expect(handler.allowedChannelTypes).toEqual([ChannelTypes.ORCHESTRATOR])
            expect(handler.allowAnonymous).toBe(true)
        }
    })
})

describe('LOGS_REQUEST is verified', () => {
    const handler = new LogsRequestHandler()

    test('this node own key without a node parameter lists the logs', () => {
        const result = handler.handle({}, relayGet(own, 'logs'))
        //readdir order is the file system's; the rotation info file is filtered out
        expect(result.logFiles.sort()).toEqual(['combined.log', 'error.log'])
        expect(result.isTraceEnabled).toBe(true)
        expect(logger.warn).not.toHaveBeenCalled()
    })

    test('the monitoring key aiming at this node lists the logs, with a warning naming it', () => {
        expect(handler.handle({}, relayGet(monitor, 'logs', {node: own.publicKey()})).logFiles.sort()).toEqual(['combined.log', 'error.log'])
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({signer: monitor.publicKey()}))
    })

    test('an unsigned request is refused', () => {
        expect(() => handler.handle({}, {data: {}})).toThrow('Signer public key is required')
        expect(() => handler.handle({}, {data: {data: 'logs?nonce=5', pubkey: own.publicKey()}})).toThrow('Signature is required')
    })

    test('a request aimed at another node is refused', () => {
        expect(() => handler.handle({}, relayGet(own, 'logs', {node: monitor.publicKey()}))).toThrow('aimed at another node')
    })

    test('another key without a node parameter is refused: such a request is for the signer own node', () => {
        expect(() => handler.handle({}, relayGet(monitor, 'logs'))).toThrow('aimed at another node')
    })

    test('a signer outside the cluster is refused', () => {
        expect(() => handler.handle({}, relayGet(outsider, 'logs', {node: own.publicKey()}))).toThrow('not a cluster node')
    })

    test('a payload altered after signing is refused', () => {
        const message = relayGet(own, 'logs')
        message.data.data = message.data.data.replace('nonce=', 'nonce=9')
        expect(() => handler.handle({}, message)).toThrow('Signature is not valid')
    })

    test('a replayed or older request is refused, and each signer has its own nonce', () => {
        const first = relayGet(own, 'logs')
        const monitorRequest = relayGet(monitor, 'logs', {node: own.publicKey()})
        const later = relayGet(own, 'logs')
        handler.handle({}, later)
        expect(() => handler.handle({}, later)).toThrow('Nonce is outdated')
        expect(() => handler.handle({}, first)).toThrow('Nonce is outdated')
        //the monitoring operator signed before this node's operator did; that is not a replay of theirs
        expect(handler.handle({}, monitorRequest).logFiles).toHaveLength(2)
    })

    test('a signature made for another route is refused', () => {
        expect(() => handler.handle({}, relayGet(own, 'logs/combined.log'))).toThrow('another route')
    })

    test('a refused signature burns no nonce: the genuine request still goes through', () => {
        const genuine = relayGet(own, 'logs')
        const altered = JSON.parse(JSON.stringify(genuine))
        altered.data.data = altered.data.data.replace('nonce=', 'nonce=9')
        expect(() => handler.handle({}, altered)).toThrow('Signature is not valid')
        expect(handler.handle({}, genuine).logFiles).toHaveLength(2)
    })

    test('a signature that is not 128 hex characters is refused before it is checked', () => {
        const message = relayGet(own, 'logs')
        message.data.signature = message.data.signature.slice(0, 126) + 'zz'
        expect(() => handler.handle({}, message)).toThrow('Signature is required')
    })

    test.each([
        ['logs', 'Signed route binding carries no nonce'],
        ['logs?nonce=abc', 'Signed request carries no valid nonce'],
        ['logs?nonce=0', 'Signed request carries no valid nonce'],
        ['logs?nonce=-5', 'Signed request carries no valid nonce'],
        ['logs?nonce=1.5', 'Signed request carries no valid nonce']
    ])('a validly signed %s is refused: %s', (payload, error) => {
        const message = {data: {data: payload, signature: signPayload(own, payload), pubkey: own.publicKey()}}
        nonceManager.setNonce.mockClear()
        expect(() => handler.handle({}, message)).toThrow(error)
        expect(nonceManager.setNonce).not.toHaveBeenCalledWith(`logs:${own.publicKey()}`, expect.anything())
    })
})

describe('LOG_FILE_REQUEST is verified', () => {
    const handler = new LogFileRequestHandler()

    test('the file named in the signed route is returned', () => {
        const result = handler.handle({}, relayGet(own, 'logs/combined.log', {}, {logFileName: 'combined.log'}))
        expect(result.logFile).toBe('line 1\nline 2')
    })

    test('an unsigned file name that differs from the signed one is refused', () => {
        expect(() => handler.handle({}, relayGet(own, 'logs/error.log', {}, {logFileName: 'combined.log'}))).toThrow('another route')
    })

    const refusedNames = ['', '.', '..', '.hidden', 'logs/combined.log', 'a\\b', '-rf', 'combined.log ']
    test.each(refusedNames)('the file name %j is refused before any file system call and burns no nonce', name => {
        const read = jest.spyOn(fs, 'readFileSync')
        nonceManager.setNonce.mockClear()
        try {
            expect(() => handler.handle({}, relayGet(own, `logs/${name}`, {}, {logFileName: name}))).toThrow('Log file name is invalid')
            //only a read under this node's own logs directory - the path the handler would have built - is this test's
            //business; an unrelated readFileSync elsewhere in the process (Jest's own lazy require of its source-map
            //libraries, for one, seen under --randomize) is not
            const logReads = read.mock.calls.filter(([target]) => String(target).startsWith(`${home}/logs/`))
            expect(logReads).toHaveLength(0)
        } finally {
            read.mockRestore()
        }
        expect(nonceManager.setNonce).not.toHaveBeenCalled()
    })

    test('a rotated log file name is accepted', () => {
        fs.writeFileSync(path.join(home, 'logs', '20260924-0000-01-combined.log'), 'rotated line\n')
        const rotated = '20260924-0000-01-combined.log'
        const result = handler.handle({}, relayGet(own, `logs/${rotated}`, {}, {logFileName: rotated}))
        expect(result.logFile).toBe('rotated line')
    })

    test.each(['missing.log', 'metrics'])('%s that cannot be read answers a fixed message, and the home path stays in the local log', name => {
        fs.mkdirSync(path.join(home, 'logs', 'metrics'), {recursive: true})
        let error = null
        try {
            handler.handle({}, relayGet(own, `logs/${name}`, {}, {logFileName: name}))
        } catch (err) {
            error = err
        }
        expect(error.message).toBe('Log file cannot be read')
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({logFileName: name, err: expect.stringMatching(/^E[A-Z]+: /)}))
    })

    test('the file system detail, which names the home path, is logged locally only', () => {
        expect(() => handler.handle({}, relayGet(own, 'logs/missing.log', {}, {logFileName: 'missing.log'}))).toThrow(/^Log file cannot be read$/)
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({err: expect.stringContaining(path.join(home, 'logs'))}))
    })

    test('a file name that is not a bare name is refused before anything is read', () => {
        expect(() => handler.handle({}, relayGet(own, 'logs/../app.config.json', {}, {logFileName: '../app.config.json'}))).toThrow('Log file name is invalid')
    })

    test('the monitoring key reads a file of this node when it names it', () => {
        const result = handler.handle({}, relayGet(monitor, 'logs/error.log', {node: own.publicKey()}, {logFileName: 'error.log'}))
        expect(result.logFile).toBe('error line')
    })
})

describe('SET_TRACE is verified', () => {
    const handler = new SetTraceHandler()

    test('this node own key sets the signed value, not the unsigned copy beside it', () => {
        handler.handle({}, relayTrace(own, false, {}, true))
        expect(container.settingsManager.setTrace).toHaveBeenCalledWith(false)
    })

    test('the monitoring key may not toggle this node, and burns no nonce trying', () => {
        expect(() => handler.handle({}, relayTrace(monitor, true, {node: own.publicKey()}))).toThrow('Only this node key may change its trace setting')
        expect(container.settingsManager.setTrace).not.toHaveBeenCalled()
        expect(nonceManager.setNonce).not.toHaveBeenCalledWith(`setTrace:${monitor.publicKey()}`, expect.anything())
    })

    test('a signed value flipped after signing is refused', () => {
        const message = relayTrace(own, false)
        message.data.data.isTraceEnabled = true
        expect(() => handler.handle({}, message)).toThrow('Signature is not valid')
        expect(container.settingsManager.setTrace).not.toHaveBeenCalled()
    })

    test('a GET-shaped signature cannot toggle tracing', () => {
        expect(() => handler.handle({}, relayGet(own, 'logs/trace'))).toThrow('another method')
    })

    test('an unsigned toggle is refused', () => {
        expect(() => handler.handle({}, {data: {isTraceEnabled: true}})).toThrow('Signer public key is required')
        expect(container.settingsManager.setTrace).not.toHaveBeenCalled()
    })

    test('a body nonce that differs from the nonce in its route is refused, although signed', () => {
        const n = nextNonce()
        const payload = sortObjectKeys({isTraceEnabled: true, nonce: n + 1, path: binding('logs/trace', {}, n)})
        const message = {data: {isTraceEnabled: true, data: payload, signature: signPayload(own, payload), pubkey: own.publicKey()}}
        expect(() => handler.handle({}, message)).toThrow('two different nonces')
        expect(container.settingsManager.setTrace).not.toHaveBeenCalled()
    })

    test('a signed value that is not a boolean is refused', () => {
        const n = nextNonce()
        const payload = sortObjectKeys({isTraceEnabled: 'true', nonce: n, path: binding('logs/trace', {}, n)})
        const message = {data: {isTraceEnabled: true, data: payload, signature: signPayload(own, payload), pubkey: own.publicKey()}}
        expect(() => handler.handle({}, message)).toThrow('isTraceEnabled must be a boolean')
        expect(container.settingsManager.setTrace).not.toHaveBeenCalled()
    })
})

describe('LOG_FILE_REQUEST answer size', () => {
    const handler = new LogFileRequestHandler()
    const budget = 768 * 1024

    test('a large log answers with its newest whole lines within 768 KiB of escaped text', () => {
        const line = JSON.stringify({level: 'info', time: '2026-09-24T00:00:00.000Z', msg: 'Loaded trade data "quoted"', source: 'exchanges'})
        const lines = Array.from({length: 20_000}, (_, i) => `${line.slice(0, -1)},"n":${i}}`)
        fs.writeFileSync(path.join(home, 'logs', 'combined.log'), lines.join('\n') + '\n')

        const {logFile, truncated} = handler.handle({}, relayGet(own, 'logs/combined.log', {}, {logFileName: 'combined.log'}))

        expect(truncated).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(logFile))).toBeLessThanOrEqual(budget)
        expect(logFile.endsWith(lines[lines.length - 1])).toBe(true)
        expect(lines).toContain(logFile.split('\n')[0]) //it starts at a whole line
    })

    test('a log under the budget in bytes whose newest lines escape to twice their size is cut to the budget too', () => {
        //700 000 bytes on disk, about 1 200 000 escaped, and the escaping is all at the new end, so one proportional cut
        //is not enough
        const plain = Array.from({length: 2_000}, (_, i) => `${i}`.padEnd(99, 'p'))
        const quoted = Array.from({length: 5_000}, (_, i) => `${i}`.padEnd(99, '"'))
        const lines = [...plain, ...quoted]
        fs.writeFileSync(path.join(home, 'logs', 'combined.log'), lines.join('\n'))

        const {logFile, truncated} = handler.handle({}, relayGet(own, 'logs/combined.log', {}, {logFileName: 'combined.log'}))

        expect(truncated).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(logFile))).toBeLessThanOrEqual(budget)
        expect(logFile.endsWith(lines[lines.length - 1])).toBe(true)
        expect(lines).toContain(logFile.split('\n')[0])
    })

    test('a small log is answered whole', () => {
        expect(handler.handle({}, relayGet(own, 'logs/combined.log', {}, {logFileName: 'combined.log'}))).toEqual({logFile: 'line 1\nline 2', truncated: false})
    })
})
