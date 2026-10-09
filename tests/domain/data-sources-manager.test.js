/*eslint-disable no-undef */
/*
 * Verifies that setDataSources(dataSources, homeDir) creates `<homeDir>/cache`
 * before initializing any provider, and forwards that path as cacheDir to each
 * provider's init() — the StellarProvider connector requires it.
 */

const mockStellarInits = []
const mockForexInits = []
const mockExchangesInits = []
const mockMkdirCalls = []
const mockSetGatewayCalls = []

jest.mock('fs', () => ({
    mkdirSync: jest.fn((...args) => {
        mockMkdirCalls.push(args)
    })
}))

jest.mock('@reflector/reflector-stellar-connector', () => (
    class FakeStellarProvider {
        async init(opts) {
            mockStellarInits.push({opts, mkdirCallsAtInit: mockMkdirCalls.length})
        }
    }
))
jest.mock('@reflector/reflector-fx-connector', () => (
    class FakeForexProvider {
        async init(opts) {
            mockForexInits.push(opts)
        }
    }
))
jest.mock('@reflector/reflector-exchanges-connector', () => (
    class FakeExchangesProvider {
        async init(opts) {
            mockExchangesInits.push(opts)
        }

        //eslint-disable-next-line class-methods-use-this
        setGateway(...args) {
            mockSetGatewayCalls.push(args)
        }
    }
))

const fs = require('fs')
const dataSourcesManager = require('../../src/domain/data-sources-manager')

function makeSource(name, sorobanRpc) {
    return {name, sorobanRpc, type: 'db'}
}

describe('DataSourcesManager.setDataSources', () => {
    beforeEach(() => {
        mockStellarInits.length = 0
        mockForexInits.length = 0
        mockExchangesInits.length = 0
        mockMkdirCalls.length = 0
        fs.mkdirSync.mockClear()
    })

    test('creates <homeDir>/cache recursively before initializing providers', async () => {
        await dataSourcesManager.setDataSources(
            [makeSource('pubnet', ['https://rpc.example'])],
            '/tmp/home'
        )

        expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/home/cache', {recursive: true})
        expect(mockStellarInits).toHaveLength(1)
        expect(mockStellarInits[0].mkdirCallsAtInit).toBeGreaterThan(0)
    })

    test('forwards cacheDir to StellarProvider init alongside rpcUrls and resolved network', async () => {
        await dataSourcesManager.setDataSources(
            [makeSource('pubnet', ['https://rpc-a', 'https://rpc-b'])],
            '/var/reflector'
        )

        expect(mockStellarInits).toHaveLength(1)
        expect(mockStellarInits[0].opts).toEqual({
            rpcUrls: ['https://rpc-a', 'https://rpc-b'],
            network: 'Public Global Stellar Network ; September 2015',
            cacheDir: '/var/reflector/cache'
        })
    })

    test('passes cacheDir to every initialised provider in the list', async () => {
        await dataSourcesManager.setDataSources(
            [
                makeSource('pubnet', ['https://rpc']),
                makeSource('testnet', ['https://rpc-tn']),
                makeSource('forex', undefined)
            ],
            './home'
        )

        expect(mockStellarInits).toHaveLength(2)
        expect(mockForexInits).toHaveLength(1)
        for (const {opts} of mockStellarInits)
            expect(opts.cacheDir).toBe('./home/cache')
        for (const opts of mockForexInits)
            expect(opts.cacheDir).toBe('./home/cache')
    })

    test('resolves the network passphrase from the dataSource name', async () => {
        await dataSourcesManager.setDataSources(
            [makeSource('testnet', ['https://rpc'])],
            '/h'
        )
        expect(mockStellarInits[0].opts.network).toBe('Test SDF Network ; September 2015')

        mockStellarInits.length = 0
        await dataSourcesManager.setDataSources(
            [makeSource('futurenet', ['https://rpc'])],
            '/h'
        )
        expect(mockStellarInits[0].opts.network).toBe('Test SDF Future Network ; October 2022')
    })

    test('records an issue and continues when an unknown provider name is supplied', async () => {
        await dataSourcesManager.setDataSources(
            [
                makeSource('mystery-source', ['https://rpc']),
                makeSource('pubnet', ['https://rpc'])
            ],
            '/h'
        )

        expect(mockStellarInits).toHaveLength(1)
        expect(mockStellarInits[0].opts.cacheDir).toBe('/h/cache')
        const issuesObj = dataSourcesManager.issues
        const issuesList = Array.isArray(issuesObj) ? issuesObj : Object.values(issuesObj || {}).flat()
        expect(issuesList.some(i => String(i).includes('mystery-source'))).toBe(true)
    })

    test('still creates the cache directory when the dataSources list is empty', async () => {
        await dataSourcesManager.setDataSources([], '/empty/home')
        expect(fs.mkdirSync).toHaveBeenCalledWith('/empty/home/cache', {recursive: true})
        expect(mockStellarInits).toHaveLength(0)
        expect(mockForexInits).toHaveLength(0)
    })
})

describe('DataSourcesManager.setGateways', () => {
    beforeEach(async () => {
        mockSetGatewayCalls.length = 0
        await dataSourcesManager.setDataSources([makeSource('exchanges', undefined)], '/h')
    })

    test('no gateways configured reaches the connector as null, the one state that may go direct', () => {
        dataSourcesManager.setGateways({urls: null, gatewayValidationKey: 'k'})
        expect(mockSetGatewayCalls).toEqual([[null, 'k']])
    })

    test('usable gateways reach the connector unchanged', () => {
        dataSourcesManager.setGateways({urls: ['https://gw-a.example', 'https://gw-b.example'], gatewayValidationKey: 'k'})
        expect(mockSetGatewayCalls).toEqual([[['https://gw-a.example', 'https://gw-b.example'], 'k']])
    })

    test('configured but none usable reaches the connector as [null], never as []', () => {
        //[] is "no gateways configured" on the connector side and would send price fetches direct, exposing the
        //node address to every exchange; [null] is a configured list with no usable entry, which fails closed
        dataSourcesManager.setGateways({urls: [], gatewayValidationKey: 'k'})
        expect(mockSetGatewayCalls).toEqual([[[null], 'k']])
    })
})

describe('DataSourcesManager default exchanges entry', () => {
    test('a node whose app config does not list exchanges still hands the gateways to the default connector', () => {
        mockSetGatewayCalls.length = 0
        jest.isolateModules(() => {
            //a fresh manager: setDataSources has never run, so only the default entry exists
            const freshManager = require('../../src/domain/data-sources-manager')
            freshManager.setGateways({urls: [], gatewayValidationKey: 'k'})
            //the default entry is stored under the same key a registered source uses, so every reader finds it
            expect(typeof freshManager.get('exchanges').instance.setGateway).toBe('function')
            expect(freshManager.get('exchanges').provider).toBe(undefined)
        })
        expect(mockSetGatewayCalls).toEqual([[[null], 'k']])
    })
})
