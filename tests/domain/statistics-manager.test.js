/*eslint-disable no-undef */
jest.mock('../../src/domain/container', () => ({settingsManager: null}))

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
