/*eslint-disable no-undef */
jest.mock('../../../src/domain/container', () => ({settingsManager: {getPriceHeartbeat: jest.fn()}}))

const container = require('../../../src/domain/container')
const {getRetentionHeartbeat} = require('../../../src/domain/prices/trades-cache')

const hour = 60 * 60 * 1000
const day = 24 * hour

describe('getRetentionHeartbeat', () => {
    test.each([
        [2 * hour, 2 * hour],
        [7 * day, 7 * day],
        [1e300, 7 * day],
        [Infinity, 2 * hour],
        [NaN, 2 * hour],
        [-1, 2 * hour]
    ])('a heartbeat of %d ms is retained as %d ms', (heartbeat, expected) => {
        container.settingsManager.getPriceHeartbeat.mockReturnValue(heartbeat)
        expect(getRetentionHeartbeat()).toBe(expected)
    })
})
