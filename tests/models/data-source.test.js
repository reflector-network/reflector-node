/*eslint-disable no-undef */
const logger = require('../../src/logger')
const DataSource = require('../../src/models/data-source')

/**
 * @param {any} providers - the providers block under test
 * @returns {DataSource}
 */
function pubnet(providers) {
    return new DataSource({type: 'db', name: 'pubnet', sorobanRpc: ['https://rpc.example.com'], providers})
}

describe('DataSource providers', () => {
    beforeEach(() => jest.clearAllMocks())

    test('an absent block means the connector defaults, without a warning', () => {
        expect(pubnet(undefined).providers).toBeUndefined()
        expect(logger.warn).not.toHaveBeenCalled()
    })

    test('an object keyed by provider is accepted without a warning', () => {
        const providers = {AQUA: {aquaListUrl: 'https://amm-api.aqua.network/pools/?size=500'}, STELLAR_LIQUIDITY: {}}
        expect(pubnet(providers).providers).toBe(providers)
        expect(logger.warn).not.toHaveBeenCalled()
    })

    test('an array of provider names is accepted without a warning', () => {
        expect(new DataSource({type: 'api', name: 'exchanges', providers: ['binance']}).providers).toEqual(['binance'])
        expect(logger.warn).not.toHaveBeenCalled()
    })

    test('an empty array or object runs no provider, and warns', () => {
        pubnet([])
        pubnet({})
        expect(logger.warn).toHaveBeenCalledTimes(2)
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({msg: 'No providers are defined for data source', source: 'pubnet'}))
    })

    test('any other type is a configuration error', () => {
        expect(() => pubnet('AQUA')).toThrow('DataSource providers must be an array or an object')
    })
})
