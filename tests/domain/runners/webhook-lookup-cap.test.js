/*eslint-disable no-undef */
//Webhooks whose names never resolve fill the validator's two lookup slots. Other subscribers' webhooks are then
//refused for as long as the slots are held; this pins that the refusal is logged per failure at debug level without the
//url, and that the paths pricing and signing use never reach the cap. Name resolution is stubbed throughout and every
//connection goes to loopback.
jest.mock('../../../src/domain/container', () => ({settingsManager: {appConfig: {publicKey: 'GVERIFIER'}}}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../../src/domain/subscriptions/subscriptions-data-manager', () => ({
    addManager: jest.fn(() => ({})),
    getManager: jest.fn(),
    removeManager: jest.fn(),
    getAllSubscriptions: jest.fn(() => [])
}))

const dns = require('dns')
const http = require('http')
const net = require('net')
const {Keypair} = require('@stellar/stellar-sdk')
const logger = require('../../../src/logger')
const {makeRequest} = require('../../../src/utils/requests-helper')
const {getVWAP, getMedianPrice} = require('../../../src/utils/price-utils')
const SubscriptionsRunner = require('../../../src/domain/runners/subscriptions-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const capMessage = 'Too many host lookups in progress'

const hanging = []
let stalledRequests = []
let promisesLookup = null
let systemLookup = null
let server = null
let port = 0

beforeAll(async () => {
    //the validator resolves through dns.promises.lookup: a name under .hang does not answer until the suite ends, which
    //is the stalled case. Every other name fails, so no validated request can ever be sent anywhere
    promisesLookup = jest.spyOn(dns.promises, 'lookup').mockImplementation(host => {
        if (host.endsWith('.hang'))
            return new Promise(resolve => hanging.push(resolve))
        const error = new Error(`getaddrinfo ENOTFOUND ${host}`)
        error.code = 'ENOTFOUND'
        return Promise.reject(error)
    })
    //everything else (rpc, exchange connectors) resolves through dns.lookup; rpc.test stands for such a host
    const realLookup = dns.lookup
    systemLookup = jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => {
        if (net.isIP(hostname))
            return realLookup(hostname, options, callback)
        const done = typeof options === 'function' ? options : callback
        if (hostname !== 'rpc.test') {
            const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`)
            error.code = 'ENOTFOUND'
            return process.nextTick(() => done(error))
        }
        if (options?.all)
            return process.nextTick(() => done(null, [{address: '127.0.0.1', family: 4}]))
        process.nextTick(() => done(null, '127.0.0.1', 4))
    })
    server = http.createServer((req, res) => res.end('{"price":"1"}'))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
})

//every test fills the slots itself and gives them back afterwards, so no test relies on another having run first
beforeEach(() => {
    promisesLookup.mockClear()
    systemLookup.mockClear()
})

afterEach(releaseLookupSlots)

afterAll(async () => {
    await releaseLookupSlots()
    promisesLookup.mockRestore()
    systemLookup.mockRestore()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
})

/**
 * Starts two webhook requests whose lookups never answer, and waits until both hold a lookup slot
 * @returns {Promise<Promise[]>} the two requests, still pending
 */
async function fillLookupSlots() {
    stalledRequests = ['http://a.hang/hook', 'http://b.hang/hook'].map(url => makeRequest(url, {method: 'POST', validateSsrf: true, timeout: 60_000}))
    stalledRequests.forEach(request => request.catch(() => {}))
    await new Promise(resolve => setImmediate(resolve))
    expect(hanging.length).toBe(2)
    return stalledRequests
}

/**
 * Answers the held lookups and waits for the stalled requests to end. A loopback answer is refused as private, so the
 * requests end without connecting and clear their deadlines. Each slot is given back when its lookup settles, which
 * is before its request ends, so the validator's counter is back to zero when this returns
 * @returns {Promise<void>}
 */
async function releaseLookupSlots() {
    for (const resolve of hanging.splice(0))
        resolve({address: '127.0.0.1', family: 4})
    await Promise.allSettled(stalledRequests)
    stalledRequests = []
}

describe('webhooks refused by the lookup cap', () => {
    test('another subscriber is refused, and each refusal is logged at debug without the url', async () => {
        await fillLookupSlots()
        logger.debug.mockClear()
        logger.info.mockClear()
        logger.warn.mockClear()
        logger.error.mockClear()
        const notifications = [
            {urls: ['https://user:hunter2@victim-one.example/p?token=s3cret', 'https://victim-two.example/q'], data: {update: {}}},
            {urls: ['https://victim-three.example/r'], data: {update: {}}}
        ]
        const runner = new SubscriptionsRunner(CONTRACT_ID)
        const started = Date.now()
        await runner.__postNotifications(notifications, [], 'root')
        expect(Date.now() - started).toBeLessThan(1000)
        const failures = logger.debug.mock.calls.map(([entry]) => entry).filter(entry => entry.msg === 'Failed to send webhook data')
        expect(failures).toEqual([
            {msg: 'Failed to send webhook data', host: 'victim-one.example', err: capMessage},
            {msg: 'Failed to send webhook data', host: 'victim-two.example', err: capMessage},
            {msg: 'Failed to send webhook data', host: 'victim-three.example', err: capMessage}
        ])
        expect(logger.info).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
        const logged = JSON.stringify(logger.debug.mock.calls)
        for (const fragment of ['hunter2', 'user', 's3cret', 'token', '/p', '/q', '/r'])
            expect(logged).not.toContain(fragment)
        //the refused names never reached the resolver
        expect(promisesLookup.mock.calls.map(([host]) => host)).toEqual(['a.hang', 'b.hang'])
    })

    test('pricing and signing do not go through the cap while it is full', async () => {
        await fillLookupSlots()
        //an unvalidated request by name, the way rpc and the price connectors reach the network, still resolves and
        //completes: it uses dns.lookup through the shared agents, not the validator
        const response = await makeRequest(`http://rpc.test:${port}/prices`, {method: 'GET'})
        expect(response.status).toBe(200)
        expect(response.data).toEqual({price: '1'})
        expect(systemLookup.mock.calls.map(([host]) => host)).toContain('rpc.test')
        expect(promisesLookup).toHaveBeenCalledTimes(2)
        //price computation and transaction signing are local and take no lookup at all
        expect(getVWAP(2_000_000n, 1_000_000n, 7)).toBe(20_000_000n)
        expect(getMedianPrice([3n, 1n, 2n])).toBe(2n)
        const keypair = Keypair.random()
        const hash = Buffer.alloc(32, 7)
        expect(keypair.verify(hash, keypair.sign(hash))).toBe(true)
        expect(promisesLookup).toHaveBeenCalledTimes(2)
    })
})
