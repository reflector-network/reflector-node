/*eslint-disable no-undef */
jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared'),
    getOracleContractState: jest.fn(),
    buildOraclePriceUpdateTransaction: jest.fn(() => Promise.resolve({}))
}))
jest.mock('../../../src/utils', () => ({
    ...jest.requireActual('../../../src/utils'),
    getAccount: jest.fn(() => Promise.resolve({}))
}))
jest.mock('../../../src/domain/data-sources-manager', () => ({
    setGateways: jest.fn(),
    setDataSources: jest.fn(),
    dispose: jest.fn(),
    get: jest.fn(),
    has: jest.fn(() => true),
    issues: []
}))

const {Asset, ContractTypes, getOracleContractState, buildOraclePriceUpdateTransaction} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const logger = require('../../../src/logger')
const SettingsManager = require('../../../src/domain/settings-manager')
const TradesManager = require('../../../src/domain/prices/trades-manager')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')
const PriceRunner = require('../../../src/domain/runners/price-runner')
const {stopTradesManagersAfterEach} = require('../../helpers/stop-trades-managers')

stopTradesManagersAfterEach(TradesManager)

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const minute = 60 * 1000
const TIMEFRAME = 5 * minute
const DAY = 24 * 60 * minute
//aligned to the timeframe
const TICK = 5_666_666 * TIMEFRAME
//the oracle runner wakes 20 s after its tick (OracleRunner.__delay)
const WAKE = TICK + 20 * 1000
const NODES = ['node-a', 'node-b', 'node-c']
const DECIMALS = 2
const ASSET_CODES = ['BTC', 'ETH', 'XLM']

/**
 * @param {string} publicKey - pubkey of the node this manager belongs to
 * @returns {SettingsManager} the real settings manager, holding one oracle on exchanges/USD with three assets
 */
function makeManager(publicKey) {
    const manager = new SettingsManager()
    const nodes = new Map(NODES.map(pubkey => [pubkey, {pubkey}]))
    manager.appConfig = {publicKey, dbSyncDelay: 0}
    manager.config = {
        nodes,
        contracts: new Map([[CONTRACT_ID, {
            contractId: CONTRACT_ID,
            type: ContractTypes.ORACLE,
            dataSource: 'exchanges',
            baseAsset: new Asset(2, 'USD'),
            decimals: DECIMALS,
            timeframe: TIMEFRAME,
            admin: 'admin',
            fee: 100,
            assets: ASSET_CODES.map(code => new Asset(2, code))
        }]])
    }
    manager.getBlockchainConnectorSettings = () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['rpc']})
    return manager
}

/**
 * Gossip every node sends for every minute of the tick's timeframe. Asset i trades at 1000 + i, so the published
 * vector of an active asset is 1000 + i and an expired asset is 0.
 * @returns {object} a PRICE_SYNC payload
 */
function makeGossip() {
    const items = {}
    for (let ts = TICK - TIMEFRAME + minute; ts <= TICK; ts += minute) {
        items[ts] = {
            assetsMap: {source: 'exchanges', baseAsset: {type: 2, code: 'USD'}, assets: ASSET_CODES.map(code => ({type: 2, code}))},
            trades: ASSET_CODES.map((code, i) => [{volume: String(1000 + i), quoteVolume: '100', source: 'binance'}])
        }
    }
    return {exchanges_USD: items}
}

/**
 * Runs one node's oracle tick on its own clock, with its own settings and trades managers fed identical gossip, and
 * returns the prices it hands to the transaction builder
 * @param {string} pubkey - node pubkey
 * @param {number} now - the node's local clock
 * @param {BigInt[]} expiration - the contract's expiration array, as that node's RPC reads it
 * @returns {Promise<BigInt[]|null>} the published vector, or null when the node skips the tick
 */
async function runNode(pubkey, now, expiration) {
    jest.useFakeTimers({now})
    try {
        container.settingsManager = makeManager(pubkey)
        container.tradesManager = new TradesManager()
        const gossip = makeGossip()
        for (const node of NODES)
            container.tradesManager.addSyncData(node, gossip)
        getOracleContractState.mockResolvedValue({isInitialized: true, lastTimestamp: BigInt(TICK - TIMEFRAME), expiration, protocol: 2})
        buildOraclePriceUpdateTransaction.mockClear()
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
        runner.__buildAndSubmitTransaction = jest.fn(buildTx => buildTx({}, 100, 0))
        if (!await runner.__workerFn(TICK))
            return null
        expect(buildOraclePriceUpdateTransaction).toHaveBeenCalledTimes(1)
        return buildOraclePriceUpdateTransaction.mock.calls[0][0].prices
    } finally {
        jest.clearAllTimers()
        jest.useRealTimers()
    }
}

describe('runner call sites evaluate expiry at their tick', () => {
    let original

    beforeEach(() => {
        original = {settingsManager: container.settingsManager, tradesManager: container.tradesManager}
        logger.debug.mockClear()
        logger.error.mockClear()
    })

    afterEach(() => {
        container.settingsManager = original.settingsManager
        container.tradesManager = original.tradesManager
        expect(logger.error.mock.calls.filter(call => call[0]?.msg === 'Failed to build the local cache keys')).toHaveLength(0)
    })

    test('the oracle runner evaluates expiry at its tick and names the guard that skipped the update', async () => {
        const manager = makeManager(NODES[0])
        const getAssets = jest.spyOn(manager, 'getAssets')
        container.settingsManager = manager
        //the contract already holds this tick, so the update is skipped by that guard alone. BTC expires just after the
        //tick, ETH was never paid for (0) and XLM expired before the tick; the clock sits past BTC's expiry, so a
        //clock read would drop BTC as well
        getOracleContractState.mockResolvedValue({
            isInitialized: true,
            lastTimestamp: BigInt(TICK),
            expiration: [BigInt(TICK + 1000), 0n, BigInt(TICK - 1000)],
            protocol: 2
        })
        const clock = jest.spyOn(Date, 'now').mockReturnValue(WAKE)
        try {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
            expect(await runner.__workerFn(TICK)).toBe(false)
        } finally {
            clock.mockRestore()
        }

        expect(getAssets).toHaveBeenCalledWith(CONTRACT_ID, TICK)
        expect(logger.debug).toHaveBeenCalledWith({
            msg: 'No oracle update for this tick',
            runner: 'OracleRunner',
            contract: CONTRACT_ID,
            type: ContractTypes.ORACLE,
            timestamp: TICK,
            timestampValid: true,
            lastTimestamp: TICK,
            txExpired: false,
            activeAssets: 1
        })
    })

    test('an unpaid feed (0) is not published next to a paid one, on every node', async () => {
        const expiration = [0n, BigInt(TICK + DAY), 0n]
        const vectors = []
        for (const [i, pubkey] of NODES.entries())
            vectors.push(await runNode(pubkey, WAKE + (i - 1) * 3000, expiration))
        for (const prices of vectors)
            expect(prices).toEqual([0n, 1001n, 0n])
    })

    test('nodes whose clocks straddle an expiry boundary publish the same vector', async () => {
        //ETH expires 10 s after the tick, XLM 5 s before it; the node clocks sit 3 s either side of ETH's expiry
        const expiration = [BigInt(TICK + DAY), BigInt(TICK + 10 * 1000), BigInt(TICK - 5 * 1000)]
        const vectors = []
        for (const [i, pubkey] of NODES.entries())
            vectors.push(await runNode(pubkey, TICK + 10 * 1000 + (i - 1) * 3000, expiration))
        for (const prices of vectors)
            expect(prices).toEqual([1000n, 1001n, 0n])
    })

    test('the price runner hands its own tick to loadTradesData', async () => {
        const loadTradesData = jest.fn()
        container.tradesManager = {loadTradesData}
        const runner = new PriceRunner()
        expect(await runner.__workerFn(TICK)).toBe(false)
        expect(loadTradesData).toHaveBeenCalledWith(TICK)
    })
})
