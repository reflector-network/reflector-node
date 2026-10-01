/*eslint-disable no-undef */
jest.mock('../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../src/utils/requests-helper', () => ({
    ...jest.requireActual('../../src/utils/requests-helper'),
    makeRequest: jest.fn()
}))

const logger = require('../../src/logger')
const container = require('../../src/domain/container')
const {makeRequest} = require('../../src/utils/requests-helper')
const statisticsManager = require('../../src/domain/statistics-manager')

describe('StatisticsManager metrics worker', () => {
    test('the re-armed metrics timer never keeps the process alive on its own', async () => {
        //the worker is async and arms its timer in finally, after the (empty) gateway round
        for (let i = 0; i < 20 && !statisticsManager.__metricsTimeout; i++)
            await new Promise(resolve => setImmediate(resolve))

        expect(statisticsManager.__metricsTimeout).toBeTruthy()
        expect(statisticsManager.__metricsTimeout.hasRef()).toBe(false)
    })
})

describe('StatisticsManager gateway metrics', () => {
    beforeEach(() => {
        makeRequest.mockReset()
        logger.error.mockClear()
        logger.warn.mockClear()
        logger.addMetrics.mockClear()
    })

    afterEach(() => {
        clearTimeout(statisticsManager.__metricsTimeout)
        container.settingsManager = null
    })

    test('no gateways configured (urls null) requests nothing and reports zero gateways', async () => {
        container.settingsManager = {gateways: {urls: null, configuredUrls: [], challenge: 'c', gatewayValidationKey: 'k'}}
        await statisticsManager.__metricsWorker()
        expect(makeRequest).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.addMetrics).toHaveBeenCalledTimes(1)
        expect(logger.addMetrics.mock.calls[0][0].gatewaysCount).toBe(0)
        expect(logger.addMetrics.mock.calls[0][0].metrics).toEqual([])
    })

    test('the metrics request goes through the validated path, and a failure logs the host only', async () => {
        const error = new Error('SSRF blocked: gw.example.com resolved to private IP 10.0.0.1')
        error.safeMessage = 'Host resolves to a private address'
        makeRequest.mockRejectedValue(error)
        container.settingsManager = {gateways: {urls: ['https://gw.example.com:8443/t0ken-path'], gatewayValidationKey: 'k'}}
        await statisticsManager.__metricsWorker()
        expect(makeRequest).toHaveBeenCalledTimes(1)
        expect(makeRequest.mock.calls[0]).toEqual(['https://gw.example.com:8443/t0ken-path/metrics', {
            headers: {'x-gateway-validation': 'k'},
            timeout: 5000,
            validateSsrf: true
        }])
        expect(logger.warn).toHaveBeenCalledWith({msg: 'Failed to send metrics data', host: 'gw.example.com:8443', err: 'Host resolves to a private address'})
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('t0ken-path')
        expect(logger.addMetrics.mock.calls[0][0].gatewaysCount).toBe(1)
        expect(logger.addMetrics.mock.calls[0][0].metrics).toEqual(['n/a'])
    })
})
