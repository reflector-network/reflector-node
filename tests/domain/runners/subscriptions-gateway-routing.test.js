/*eslint-disable no-undef */
jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../../src/utils/requests-helper', () => ({
    ...jest.requireActual('../../../src/utils/requests-helper'),
    makeRequest: jest.fn()
}))
jest.mock('../../../src/domain/subscriptions/subscriptions-data-manager', () => ({
    addManager: jest.fn(),
    getManager: jest.fn(),
    removeManager: jest.fn(),
    getAllSubscriptions: jest.fn(() => [])
}))

const logger = require('../../../src/logger')
const container = require('../../../src/domain/container')
const {makeRequest} = require('../../../src/utils/requests-helper')
const SubscriptionsRunner = require('../../../src/domain/runners/subscriptions-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const VERIFIER = 'GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX'

/**
 * @param {string[]|null} urls - the routing set to install on settingsManager.gateways
 * @returns {SubscriptionsRunner} a runner with both post paths stubbed
 */
function makeRunner(urls) {
    container.settingsManager = {
        appConfig: {publicKey: VERIFIER},
        gateways: {urls, configuredUrls: urls || [], challenge: 'c', gatewayValidationKey: 'k'}
    }
    const runner = Object.create(SubscriptionsRunner.prototype)
    runner.contractId = CONTRACT_ID
    runner.__payloadMajorityData = {promise: Promise.resolve(true)}
    runner.__processSingleTriggerDataItem = () => ({urls: ['https://subscriber.example.com/hook'], data: {}})
    runner.__postNotificationsViaGateway = jest.fn()
    runner.__postNotifications = jest.fn()
    return runner
}

beforeEach(() => {
    logger.error.mockClear()
    logger.debug.mockClear()
    makeRequest.mockReset()
})

describe('webhook routing across the three gateway states', () => {
    test('no gateways configured posts directly', async () => {
        const runner = makeRunner(null)
        await runner.__processTriggerData([{}], ['e'], 'root', 1_700_000_000_000)
        expect(runner.__postNotifications).toHaveBeenCalledTimes(1)
        expect(runner.__postNotificationsViaGateway).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.debug.mock.calls.map(([entry]) => entry.msg)).toContain('Webhook data sent')
    })

    test('a usable gateway routes through the gateway', async () => {
        const runner = makeRunner(['https://gw.example.com'])
        await runner.__processTriggerData([{}], ['e'], 'root', 1_700_000_000_000)
        expect(runner.__postNotificationsViaGateway).toHaveBeenCalledTimes(1)
        expect(runner.__postNotificationsViaGateway.mock.calls[0][0]).toEqual(['https://gw.example.com'])
        expect(runner.__postNotificationsViaGateway.mock.calls[0][1]).toBe('k')
        expect(runner.__postNotifications).not.toHaveBeenCalled()
    })

    test('configured but none usable posts nothing at all - never directly', async () => {
        const runner = makeRunner([])
        await runner.__processTriggerData([{}], ['e'], 'root', 1_700_000_000_000)
        expect(runner.__postNotifications).not.toHaveBeenCalled()
        expect(runner.__postNotificationsViaGateway).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledTimes(1)
        expect(logger.error).toHaveBeenCalledWith({
            msg: 'Gateways are configured but none is usable; webhook notifications dropped rather than sent directly',
            contract: CONTRACT_ID,
            timestamp: 1_700_000_000_000,
            notificationsCount: 1
        })
        //the routing returns after its error: nothing may claim afterwards that webhook data was sent
        expect(logger.debug.mock.calls.map(([entry]) => entry.msg)).not.toContain('Webhook data sent')
    })
})

/**
 * @returns {SubscriptionsRunner} a runner whose real gateway post path is under test
 */
function makeGatewayRunner() {
    container.settingsManager = {appConfig: {publicKey: VERIFIER}}
    const runner = Object.create(SubscriptionsRunner.prototype)
    runner.contractId = CONTRACT_ID
    return runner
}

describe('the gateway POST', () => {
    const gateway = 'https://gw.example.com:8443/t0ken-path'

    test('goes through the validated path with the gateway token and nothing else', async () => {
        makeRequest.mockResolvedValue({status: 200})
        const runner = makeGatewayRunner()
        const notifications = [{urls: ['https://subscriber.example.com/hook'], data: {}}]
        await runner.__postNotificationsViaGateway([gateway], 'k', notifications, ['e'], 'root')
        expect(makeRequest).toHaveBeenCalledTimes(1)
        expect(makeRequest.mock.calls[0][0]).toBe(`${gateway}/notifications`)
        expect(makeRequest.mock.calls[0][1]).toEqual({
            method: 'POST',
            headers: {'x-gateway-validation': 'k'},
            data: {notifications, events: ['e'], root: 'root', verifier: VERIFIER, contract: CONTRACT_ID},
            timeout: 5000,
            validateSsrf: true
        })
    })

    test('logs only the gateway host, never its path', async () => {
        const error = new Error('SSRF blocked: gw.example.com resolved to private IP 10.0.0.1')
        error.safeMessage = 'Host resolves to a private address'
        makeRequest.mockRejectedValue(error)
        const runner = makeGatewayRunner()
        await runner.__postNotificationsViaGateway([gateway], 'k', [], ['e'], 'root')
        const failure = logger.debug.mock.calls.map(([entry]) => entry).find(entry => entry.msg === 'Failed to send webhook data to gateway')
        expect(failure).toEqual({msg: 'Failed to send webhook data to gateway', host: 'gw.example.com:8443', err: 'Host resolves to a private address'})
        const sending = logger.debug.mock.calls.map(([entry]) => entry).find(entry => entry.msg === 'Sending webhook data to gateways')
        expect(sending.hosts).toEqual(['gw.example.com:8443'])
        const logged = JSON.stringify([logger.debug.mock.calls, logger.error.mock.calls])
        expect(logged).not.toContain('t0ken-path')
    })

    test('a successful gateway is logged by host only', async () => {
        makeRequest.mockResolvedValue({status: 200})
        const runner = makeGatewayRunner()
        await runner.__postNotificationsViaGateway([gateway], 'k', [], ['e'], 'root')
        const sent = logger.debug.mock.calls.map(([entry]) => entry).find(entry => entry.msg === 'Webhook data sent to gateways')
        expect(sent.hosts).toEqual(['gw.example.com:8443'])
        expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('t0ken-path')
    })
})
