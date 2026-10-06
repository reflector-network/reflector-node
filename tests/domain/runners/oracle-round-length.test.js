/*eslint-disable no-undef */
jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared'),
    getOracleContractState: jest.fn()
}))
jest.mock('../../../src/utils', () => ({
    ...jest.requireActual('../../../src/utils'),
    getAccount: jest.fn(() => Promise.resolve({}))
}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastOracleData: jest.fn()}))
jest.mock('../../../src/domain/prices/price-manager', () => ({getPricesForContract: jest.fn(async () => [100n])}))

const {ContractTypes, getOracleContractState} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const minute = 60 * 1000
const TIMEFRAME = 5 * minute
const TICK = 6_000_000 * TIMEFRAME

beforeEach(() => {
    container.settingsManager = {
        getContractConfig: () => ({contractId: CONTRACT_ID, timeframe: TIMEFRAME, admin: 'admin', fee: 100}),
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['rpc']}),
        setAssetExpiration: jest.fn(),
        getAssets: () => [{code: 'BTC'}],
        getDecimals: () => 2,
        getPriceHeartbeat: () => 2 * 60 * minute
    }
})

/**
 * @param {object} state - the contract state the round reads
 * @returns {Promise<OracleRunner>} the runner after one round
 */
async function roundWith(state) {
    getOracleContractState.mockResolvedValue({protocol: 2, ...state})
    const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
    runner.__buildAndSubmitTransaction = jest.fn(async () => ({response: null, tx: null}))
    await runner.__workerFn(TICK)
    return runner
}

afterEach(() => {
    jest.restoreAllMocks()
})

describe('the oracle round follows the contract state it read', () => {
    test('an uninitialized contract: the init round lasts a minute and the next tick is a minute on', async () => {
        const runner = await roundWith({isInitialized: false, lastTimestamp: 0n})
        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1) //the init transaction
        expect(runner.__isInitialized).toBe(false)
        expect(runner.__roundLength).toBe(minute)
        expect(runner.__getNextTimestamp(TICK)).toBe(TICK + minute)
    })

    test('an initialized contract: rounds last the timeframe and ticks follow its grid', async () => {
        const runner = await roundWith({isInitialized: true, lastTimestamp: BigInt(TICK)})
        expect(runner.__isInitialized).toBe(true)
        expect(runner.__roundLength).toBe(TIMEFRAME)
        expect(runner.__getNextTimestamp(TICK)).toBe(TICK + TIMEFRAME)
    })

    //the round length decides whether the round is still live, so it has to follow the state this round read: a
    //restarted node judged by a one-minute round would abstain for the rest of the timeframe
    test('a node restarted three minutes into a five-minute round still prices that round', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(TICK + 3 * minute)
        getOracleContractState.mockResolvedValue({protocol: 2, isInitialized: true, lastTimestamp: BigInt(TICK - TIMEFRAME)})
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
        runner.__getPricesToUpdate = async prices => prices
        runner.__buildAndSubmitTransaction = jest.fn(async () => ({response: null, tx: null}))
        expect(await runner.__workerFn(TICK)).toBe(true)
        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        expect(runner.__roundLength).toBe(TIMEFRAME)
    })
})
