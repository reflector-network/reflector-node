/*eslint-disable no-undef */
jest.mock('../../../src/domain/container', () => ({settingsManager: {appConfig: {publicKey: 'GVERIFIER'}}}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../../src/domain/subscriptions/subscriptions-data-manager', () => ({
    addManager: jest.fn(() => ({})),
    getManager: jest.fn(),
    removeManager: jest.fn(),
    getAllSubscriptions: jest.fn(() => [])
}))
jest.mock('../../../src/utils/requests-helper', () => ({
    ...jest.requireActual('../../../src/utils/requests-helper'),
    makeRequest: jest.fn()
}))

const logger = require('../../../src/logger')
const {makeRequest, loggableHost} = require('../../../src/utils/requests-helper')
const SubscriptionsRunner = require('../../../src/domain/runners/subscriptions-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const webhook = 'https://subscriber:hunter2@hooks.example.com:8443/private/path?token=s3cret'

beforeEach(() => {
    logger.debug.mockClear()
    makeRequest.mockReset()
})

/**
 * Sends one notification to the subscriber's webhook with the request failing as given
 * @param {Error} error - what the request rejects with
 * @returns {Promise<object>} the failure log entry
 */
async function failureLogFor(error) {
    makeRequest.mockImplementation(() => Promise.reject(error))
    const runner = new SubscriptionsRunner(CONTRACT_ID)
    await runner.__postNotifications([{urls: [webhook], data: {update: {}}}], [], 'root')
    expect(makeRequest).toHaveBeenCalledTimes(1)
    expect(makeRequest.mock.calls[0][0]).toBe(webhook)
    expect(makeRequest.mock.calls[0][1].validateSsrf).toBe(true)
    const entries = logger.debug.mock.calls.map(([entry]) => entry).filter(entry => entry.msg === 'Failed to send webhook data')
    expect(entries.length).toBe(1)
    return entries[0]
}

describe('a failed webhook delivery is logged without the url', () => {
    test('only the host is logged, with the safe reason', async () => {
        const error = new Error('SSRF blocked: hooks.example.com resolved to private IP 10.0.0.1')
        error.safeMessage = 'Host resolves to a private address'
        const entry = await failureLogFor(error)
        expect(entry).toEqual({msg: 'Failed to send webhook data', host: 'hooks.example.com:8443', err: 'Host resolves to a private address'})
        const logged = JSON.stringify(logger.debug.mock.calls)
        for (const fragment of ['hunter2', 'subscriber', 'private/path', 'token', 's3cret'])
            expect(logged).not.toContain(fragment)
    })

    test('an error without a safe reason keeps its message', async () => {
        const entry = await failureLogFor(new Error('Request failed with status code 302'))
        expect(entry.err).toBe('Request failed with status code 302')
        expect(entry.url).toBe(undefined)
    })
})

describe('loggableHost', () => {
    test('keeps the host and port only', () => {
        expect(loggableHost(webhook)).toBe('hooks.example.com:8443')
        expect(loggableHost('http://[::ffff:127.0.0.1]:6379/x')).toBe('[::ffff:7f00:1]:6379')
        expect(loggableHost('http://example.com/a?b=c')).toBe('example.com')
    })

    test('never echoes an unparseable url', () => {
        expect(loggableHost('not a url with a s3cret')).toBe('invalid url')
        expect(loggableHost(undefined)).toBe('invalid url')
    })
})
