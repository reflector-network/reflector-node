/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const {getDataHash, sortObjectKeys} = require('@reflector/reflector-shared')

//node-orchestrator's own HTTP stack - express, its body parser, registerRoute, the authenticate middleware and the log
//routes - verifies each request and relays it; this node's HandlersManager then handles the relayed frame. Signed,
//verified and relayed bytes are therefore compared across the two repositories, not against a copy of either.
//The sibling checkout is expected at ../node-orchestrator; without it the suite fails unless SKIP_CROSS_REPO=1
//is set
const {describeWithOrchestrator, orch} = require('./orchestrator-sibling')

const orchestratorModules = [
    'server/middlewares.js', 'server/route.js', 'server/routes/log-routes.js', 'server/errors.js', 'node_modules/express', 'node_modules/body-parser'
]

jest.mock('../../src/domain/container', () => {
    const home = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reflector-parity-'))
    require('fs').mkdirSync(require('path').join(home, 'logs'))
    return {homeDir: home, settingsManager: null}
})

const own = Keypair.random()
const monitor = Keypair.random() //the orchestrator's monitoringKey, a cluster node key that is not this node's
let nonce = 1_700_000_000_000

/**
 * @returns {number} a nonce above every earlier one, as the dashboard's clock gives
 */
function nextNonce() {
    nonce += 1
    return nonce
}

/**
 * @param {Keypair} kp - signer
 * @param {string|object} payload - signed payload
 * @returns {string} hex signature, as admin-dashboard's Albedo signData returns it
 */
function signPayload(kp, payload) {
    const hash = createHash('sha256').update(`${kp.publicKey()}:${JSON.stringify(payload)}`, 'utf8').digest()
    return Buffer.from(kp.sign(hash)).toString('hex')
}

describeWithOrchestrator('control messages: node-orchestrator verifies and relays, this node verifies the same bytes', orchestratorModules, () => {
    const relayed = []
    const orchestratorNonces = new Map()
    let container
    let server
    let baseUrl
    let settingsManager

    beforeAll(async () => {
        jest.doMock(orch('logger.js'), () => ({error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn()}))
        jest.doMock(orch('domain/nonce-provider.js'), () => ({
            get: pubkey => Promise.resolve(orchestratorNonces.get(pubkey) || 0),
            tryConsume: (pubkey, value) => {
                if (value <= (orchestratorNonces.get(pubkey) || 0))
                    return Promise.resolve(false)
                orchestratorNonces.set(pubkey, value)
                return Promise.resolve(true)
            }
        }))
        const HandlersManager = require('../../src/ws-server/handlers/handlers-manager')
        const ChannelTypes = require('../../src/ws-server/channels/channel-types')
        const handlersManager = new HandlersManager()
        //the orchestrator channel of this node, as ChannelBase carries a frame: JSON out, JSON in, and a node error
        //comes back as a peer error
        const nodeConnection = {
            async send(message) {
                const frame = JSON.parse(JSON.stringify(message))
                relayed.push(frame)
                try {
                    return await handlersManager.handle({type: ChannelTypes.ORCHESTRATOR, isValidated: false}, frame)
                } catch (err) {
                    const peerError = new Error(err.message)
                    peerError.isPeerError = true
                    throw peerError
                }
            }
        }
        jest.doMock(orch('domain/container.js'), () => ({
            appConfig: {monitoringKey: monitor.publicKey(), whitelist: []},
            configManager: {hasNode: pubkey => pubkey === own.publicKey() || pubkey === monitor.publicKey()},
            connectionManager: {getNodeConnection: pubkey => (pubkey === own.publicKey() ? nodeConnection : null)}
        }))
        const express = require(orch('node_modules/express'))
        const bodyParser = require(orch('node_modules/body-parser'))
        const logRoutes = require(orch('server/routes/log-routes.js'))
        const {HttpError, fromRelayError} = require(orch('server/errors.js'))
        const app = express()
        app.use(bodyParser.json())
        app.use(bodyParser.urlencoded({extended: false}))
        logRoutes(app)
        //node-orchestrator server/index.js error handler, without its request log; express knows an error handler by
        //its four parameters
        //eslint-disable-next-line no-unused-vars
        app.use((err, req, res, next) => {
            err = fromRelayError(err) || err
            if (err instanceof HttpError)
                return res.status(err.code).json({error: err.message, status: err.code})
            return res.status(500).json({error: 'Internal server error', status: 500})
        })
        server = await new Promise(resolve => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
        })
        baseUrl = `http://127.0.0.1:${server.address().port}/`

        container = require('../../src/domain/container')
        fs.writeFileSync(path.join(container.homeDir, 'logs', 'combined.log'), 'combined line 1\ncombined line 2\n')
        fs.writeFileSync(path.join(container.homeDir, 'logs', 'error.log'), 'error line\n')
    })

    beforeEach(() => {
        relayed.length = 0
        settingsManager = {
            appConfig: {publicKey: own.publicKey(), trace: false},
            config: {nodes: new Map([[own.publicKey(), {}], [monitor.publicKey(), {}]])},
            setTrace: jest.fn()
        }
        container.settingsManager = settingsManager
    })

    afterAll(async () => {
        if (server) {
            server.closeAllConnections() //fetch keeps its sockets alive, which close() would wait out
            await new Promise(resolve => server.close(resolve))
        }
        if (container)
            fs.rmSync(container.homeDir, {recursive: true, force: true})
    })

    /**
     * A GET as admin-dashboard's getApi sends it: the relative url and, signed, that url with the nonce sorted in
     * @param {Keypair} kp - signer
     * @param {string} endpoint - endpoint without a leading slash
     * @param {object} [query] - query parameters
     * @returns {Promise<{status: number, body: any, signedPayload: string}>}
     */
    async function get(kp, endpoint, query = {}) {
        const n = nextNonce()
        const params = new URLSearchParams(query)
        const relativeUrl = endpoint + (params.size > 0 ? '?' + params.toString() : '')
        const signedPayload = endpoint + '?' + new URLSearchParams(sortObjectKeys({...query, nonce: n})).toString()
        const res = await fetch(baseUrl + relativeUrl, {
            headers: {'Content-Type': 'application/json', Authorization: `${kp.publicKey()}.${signPayload(kp, signedPayload)}.${n}`}
        })
        return {status: res.status, body: await res.json(), signedPayload}
    }

    /**
     * A POST as admin-dashboard's postApi sends it: the body, and signed, the body with the nonce and the
     * route binding of the action
     * @param {Keypair} kp - signer
     * @param {string} action - endpoint with its query string
     * @param {object} data - body
     * @returns {Promise<{status: number, body: any, signedPayload: object}>}
     */
    async function post(kp, action, data) {
        const n = nextNonce()
        const [route, query = ''] = action.split('?')
        const params = Object.fromEntries(new URLSearchParams(query))
        const binding = route + '?' + new URLSearchParams(sortObjectKeys({...params, nonce: n})).toString()
        const signedPayload = sortObjectKeys({...data, nonce: n, path: binding})
        const res = await fetch(baseUrl + action, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `${kp.publicKey()}.${signPayload(kp, signedPayload)}.${n}`},
            body: JSON.stringify(data)
        })
        return {status: res.status, body: await res.json(), signedPayload}
    }

    /**
     * The relayed payload is the signed one byte for byte, and this node's hash of it is the hash the orchestrator
     * verified
     * @param {Keypair} kp - signer
     * @param {string|object} signedPayload - what the client signed
     */
    function expectSameBytes(kp, signedPayload) {
        expect(relayed).toHaveLength(1)
        const [{data}] = relayed
        expect(data.pubkey).toBe(kp.publicKey())
        expect(JSON.stringify(data.data)).toBe(JSON.stringify(signedPayload))
        const orchestratorHash = createHash('sha256').update(`${kp.publicKey()}:${JSON.stringify(signedPayload)}`, 'utf8').digest('hex')
        expect(getDataHash(data.data, kp.publicKey())).toBe(orchestratorHash)
    }

    test('LOGS_REQUEST by this node own key', async () => {
        const {status, body, signedPayload} = await get(own, 'logs')

        expect(status).toBe(200)
        expect(body.logFiles.sort()).toEqual(['combined.log', 'error.log'])
        expect(signedPayload).toMatch(/^logs\?nonce=\d+$/)
        expectSameBytes(own, signedPayload)
    })

    test('LOGS_REQUEST by the monitoring key with node=', async () => {
        const {status, body, signedPayload} = await get(monitor, 'logs', {node: own.publicKey()})

        expect(status).toBe(200)
        expect(body.logFiles.sort()).toEqual(['combined.log', 'error.log'])
        expect(signedPayload).toBe(`logs?node=${own.publicKey()}&nonce=${nonce}`)
        expectSameBytes(monitor, signedPayload)
    })

    test('LOG_FILE_REQUEST for a log file path, by either key', async () => {
        const first = await get(own, 'logs/combined.log')
        expect(first.status).toBe(200)
        expect(first.body.logFile).toBe('combined line 1\ncombined line 2')
        expect(relayed[0].data.logFileName).toBe('combined.log')
        expectSameBytes(own, first.signedPayload)

        relayed.length = 0
        const second = await get(monitor, 'logs/error.log', {node: own.publicKey()})
        expect(second.status).toBe(200)
        expect(second.body.logFile).toBe('error line')
        expect(second.signedPayload).toBe(`logs/error.log?node=${own.publicKey()}&nonce=${nonce}`)
        expectSameBytes(monitor, second.signedPayload)
    })

    test('SET_TRACE by this node own key, with logs/trace?node=', async () => {
        const {status, signedPayload} = await post(own, `logs/trace?node=${own.publicKey()}`, {isTraceEnabled: true})

        expect(status).toBe(200)
        expect(signedPayload.path).toBe(`logs/trace?node=${own.publicKey()}&nonce=${nonce}`)
        expectSameBytes(own, signedPayload)
        expect(settingsManager.setTrace).toHaveBeenCalledWith(true)
    })

    test('SET_TRACE by this node own key, without a query', async () => {
        const {status, signedPayload} = await post(own, 'logs/trace', {isTraceEnabled: false})

        expect(status).toBe(200)
        expect(signedPayload).toEqual({isTraceEnabled: false, nonce, path: `logs/trace?nonce=${nonce}`})
        expectSameBytes(own, signedPayload)
        expect(settingsManager.setTrace).toHaveBeenCalledWith(false)
    })

    test('the monitoring key passes the orchestrator for logs/trace?node= and this node refuses it', async () => {
        const {status, body, signedPayload} = await post(monitor, `logs/trace?node=${own.publicKey()}`, {isTraceEnabled: true})

        expectSameBytes(monitor, signedPayload) //relayed, so the orchestrator verified it
        expect(status).toBe(502)
        expect(body.error).toContain('Only this node key may change its trace setting')
        expect(settingsManager.setTrace).not.toHaveBeenCalled()
    })

    test('a node that is not in this node config is refused even though the orchestrator knows it', async () => {
        settingsManager.config.nodes.delete(monitor.publicKey())

        const {status, body} = await get(monitor, 'logs', {node: own.publicKey()})

        expect(relayed).toHaveLength(1)
        expect(status).toBe(502)
        expect(body.error).toContain('Signer is not a cluster node')
    })
})
