/*eslint-disable no-undef */
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')

/**
 * The rpc cluster the node sees: urls in `hung` accept a request and never answer. Every request is logged.
 */
const mockRpc = {hung: new Set(), requests: []}

//the node's own rpc helper runs for real against this server: a hung url fails only when the deadline makeServerRequest
//puts on httpClient.defaults elapses, exactly as the sdk's fetch adapter does (see tests/utils/rpc-deadline.test.js)
jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk')
    class Server {
        constructor(url) {
            this.url = url
            this.httpClient = {defaults: {}}
        }

        getAccount(accountId) {
            mockRpc.requests.push(['getAccount', this.url])
            if (!mockRpc.hung.has(this.url))
                return Promise.resolve(new actual.Account(accountId, '1'))
            const {timeout} = this.httpClient.defaults
            return new Promise((resolve, reject) => {
                if (timeout > 0)
                    setTimeout(() => reject(new Error(`timeout of ${timeout}ms exceeded`)), timeout)
            })
        }
    }
    return {...actual, rpc: {...actual.rpc, Server}}
})

//reflector-shared loads its own sdk copy, so its reads are modelled here instead. Its makeRequest (the contract instance
//and the history entries) is modelled as it behaves before any url has answered: it tries the urls in configured order
//and gives a hung url its 15 s deadline before it moves on - measured against the local reflector-shared: two chunks
//through a hung first url finish at 15.05 s and 30.07 s. From then on it starts at the url that answered.
//The simulations (the version read and the build) go through reflector-shared's client instead, with the same 15 s
//fail-over.
jest.mock('@reflector/reflector-shared', () => {
    const actual = jest.requireActual('@reflector/reflector-shared')
    const requestThroughUrls = async (method, urls, answer) => {
        for (const url of urls) {
            mockRpc.requests.push([method, url])
            if (!mockRpc.hung.has(url))
                return answer()
            await new Promise(resolve => setTimeout(resolve, 15_000))
        }
        throw new Error('Failed to invoke RPC method on all provided URLs')
    }
    class MockPriceUpdate extends actual.PendingTransactionBase {
    }
    return {
        ...actual,
        //two requests, as in the real helper: the version simulation, then the contract instance
        getOracleContractState: jest.fn(async (contractId, urls) => {
            await requestThroughUrls('simulateTransaction', urls, () => null)
            return await requestThroughUrls('getLedgerEntries', urls, () => mockRpc.state)
        }),
        getContractEntries: jest.fn((contractId, urls) => requestThroughUrls('getLedgerEntries', urls, () => mockRpc.entries)),
        //the transaction hash is a function of the payload alone, so two nodes that sign one hash signed one payload
        buildOraclePriceUpdateTransaction: jest.fn(options => requestThroughUrls('simulateTransaction', options.sorobanRpc, () => {
            const hash = require('crypto').createHash('sha256').update(`${options.timestamp}:${options.prices.join(',')}`).digest()
            return new MockPriceUpdate({hash: () => hash, fee: options.fee, toXdr: () => 'xdr'}, options.timestamp, actual.PendingTransactionType.ORACLE_PRICE_UPDATE)
        }))
    }
})
jest.mock('../../../src/domain/prices/price-manager', () => ({
    getPricesForContract: jest.fn()
}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(() => Promise.resolve()), sendTo: jest.fn()}))
jest.mock('../../../src/domain/data-sources-manager', () => ({
    setGateways: jest.fn(),
    setDataSources: jest.fn(),
    dispose: jest.fn(),
    get: jest.fn(),
    has: jest.fn(() => true),
    issues: []
}))

const {ContractTypes, getContractEntries, buildOraclePriceUpdateTransaction} = require('@reflector/reflector-shared')
const {getPricesForContract} = require('../../../src/domain/prices/price-manager')
const nodesManager = require('../../../src/domain/nodes/nodes-manager')
const MessageTypes = require('../../../src/ws-server/handlers/message-types')
const container = require('../../../src/domain/container')
const SettingsManager = require('../../../src/domain/settings-manager')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')
const {__resetUrlPreference} = require('../../../src/utils/rpc-helper')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const HUNG_URL = 'http://rpc-hung'
const HEALTHY_URL = 'http://rpc-healthy'
const TIMEFRAME = 5 * 60 * 1000
const HEARTBEAT = 2 * 60 * 60 * 1000
//three timeframes past a heartbeat boundary: the last on-chain entry is past the boundary, so this is a threshold tick
const TICK = 1000 * HEARTBEAT + 3 * TIMEFRAME
const NEXT_TICK = TICK + TIMEFRAME
const WORKER_DELAY = 20_000
const ON_CHAIN = [1_000_000_000n, 2_000_000_000n]
//asset 0 moved 1 ppb (below its 10 permille threshold), asset 1 moved 50% (above it)
const CURRENT = [1_000_000_001n, 3_000_000_000n]
const SIGNED = [0n, 3_000_000_000n]
const ownKp = Keypair.random()
//three nodes: this node's own signature is never a majority, so nothing here is submitted
const cluster = [ownKp, Keypair.random(), Keypair.random()]

/**
 * @param {bigint[]} prices - prices of assets 0..n-1, all present
 * @returns {{mask: Buffer, prices: bigint[]}} the update as the contract stores it
 */
function storedUpdate(prices) {
    const mask = Buffer.alloc(32, 0)
    for (let i = 0; i < prices.length; i++)
        mask[Math.floor(i / 8)] |= 1 << (i % 8)
    return {mask, prices}
}

/**
 * @param {number} timestamp - tick
 * @param {bigint[]} prices - payload
 * @returns {string} the hash MockPriceUpdate gives that payload
 */
function payloadHash(timestamp, prices) {
    return createHash('sha256').update(`${timestamp}:${prices.join(',')}`).digest('hex')
}

/**
 * Starts one worker call at its scheduled start time and records how it ends
 * @param {OracleRunner} runner - runner under test
 * @param {number} tick - tick timestamp
 * @returns {{outcome: string}} live view of the outcome
 */
function startWorker(runner, tick) {
    jest.setSystemTime(tick + WORKER_DELAY)
    const view = {outcome: 'pending'}
    runner.__workerFn(tick).then(() => {
        view.outcome = 'resolved'
    }, e => {
        view.outcome = e.message
    })
    return view
}

describe('a hung first rpc url: the node abstains for the tick instead of failing over', () => {
    let originalSettings
    const runners = []

    /**
     * @returns {OracleRunner}
     */
    function makeNode() {
        const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
        runner.isRunning = true
        runners.push(runner)
        return runner
    }

    beforeEach(() => {
        jest.useFakeTimers()
        //the preference is module state, and both tests below read the same url list: without this, a preference left
        //by whichever test ran first (order is not fixed under --randomize) changes which url the other tries first
        __resetUrlPreference()
        originalSettings = container.settingsManager
        const manager = new SettingsManager()
        manager.config = {
            nodes: new Map(cluster.map(kp => [kp.publicKey(), {pubkey: kp.publicKey()}])),
            contracts: new Map([[CONTRACT_ID, {
                contractId: CONTRACT_ID,
                type: ContractTypes.ORACLE_BEAM,
                timeframe: TIMEFRAME,
                admin: cluster[0].publicKey(),
                fee: 100,
                assets: [{code: 'BTC', threshold: 10}, {code: 'ETH', threshold: 10}]
            }]])
        }
        manager.appConfig = {keypair: ownKp, publicKey: ownKp.publicKey()}
        manager.getBlockchainConnectorSettings = () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: [HUNG_URL, HEALTHY_URL]})
        container.settingsManager = manager
        mockRpc.hung = new Set()
        mockRpc.requests = []
        mockRpc.state = {isInitialized: true, lastTimestamp: BigInt(TICK - TIMEFRAME), protocol: 2}
        mockRpc.entries = {[TICK - TIMEFRAME]: storedUpdate(ON_CHAIN)}
        getPricesForContract.mockImplementation(() => Promise.resolve([...CURRENT]))
        getContractEntries.mockClear()
        buildOraclePriceUpdateTransaction.mockClear()
        nodesManager.broadcast.mockClear()
    })

    afterEach(async () => {
        for (const runner of runners.splice(0)) {
            runner.__pendingTransaction?.submitPromise.catch(() => {})
            runner.stop()
        }
        await jest.advanceTimersByTimeAsync(1)
        jest.clearAllTimers()
        jest.useRealTimers()
        container.settingsManager = originalSettings
    })

    test('the tick with the hung url signs nothing, and the next tick signs the healthy payload once the url answers', async () => {
        const node = makeNode()
        mockRpc.hung.add(HUNG_URL)

        const hungTick = startWorker(node, TICK)
        await jest.advanceTimersByTimeAsync(19_999)
        expect(hungTick.outcome).toBe('pending')
        //the account read failed over at its 15 s deadline; the state read then went back to the hung url first
        expect(mockRpc.requests).toEqual([
            ['getAccount', HUNG_URL],
            ['getAccount', HEALTHY_URL],
            ['simulateTransaction', HUNG_URL]
        ])
        await jest.advanceTimersByTimeAsync(2)
        expect(hungTick.outcome).toBe('Pre-build contract reads timed out.')

        //the abandoned state read finishes through the healthy url long after the budget; nothing is built from it
        await jest.advanceTimersByTimeAsync(60_000)
        expect(mockRpc.requests.slice(3)).toEqual([
            ['simulateTransaction', HEALTHY_URL],
            ['getLedgerEntries', HUNG_URL],
            ['getLedgerEntries', HEALTHY_URL]
        ])
        expect(getContractEntries).not.toHaveBeenCalled()
        expect(buildOraclePriceUpdateTransaction).not.toHaveBeenCalled()
        expect(node.__pendingTransaction).toBe(null)
        expect(nodesManager.broadcast).not.toHaveBeenCalled()

        //the first url answers again: the next tick signs the thresholded payload, the one every healthy node signs
        mockRpc.hung.clear()
        mockRpc.requests = []
        const nextTick = startWorker(node, NEXT_TICK)
        await jest.advanceTimersByTimeAsync(100)
        expect(nextTick.outcome).toBe('pending') //waiting for peer signatures, as a healthy node does
        expect(buildOraclePriceUpdateTransaction).toHaveBeenCalledTimes(1)
        expect(buildOraclePriceUpdateTransaction.mock.calls[0][0]).toEqual(expect.objectContaining({prices: SIGNED, timestamp: NEXT_TICK}))
        expect(node.__pendingTransaction.tx.hashHex).toBe(payloadHash(NEXT_TICK, SIGNED))

        expect(nodesManager.broadcast).toHaveBeenCalledTimes(1)
        const [message] = nodesManager.broadcast.mock.calls[0]
        expect(message.type).toBe(MessageTypes.SIGNATURE)
        expect(message.data.contractId).toBe(CONTRACT_ID)
        expect(message.data.hash).toBe(payloadHash(NEXT_TICK, SIGNED))
        //ed25519 signatures are deterministic: this is this node's own signature over exactly that hash
        expect(message.data.signature).toBe(ownKp.signDecorated(Buffer.from(message.data.hash, 'hex')).toXDR('hex'))
    })

    test('a node with a healthy rpc signs the tick the hung node abstains from; the hung node adds no second payload', async () => {
        const healthy = makeNode()
        startWorker(healthy, TICK)
        await jest.advanceTimersByTimeAsync(100)
        expect(nodesManager.broadcast).toHaveBeenCalledTimes(1)
        expect(nodesManager.broadcast.mock.calls[0][0].data.hash).toBe(payloadHash(TICK, SIGNED))
        //stopped once it has signed, so its own retry attempts do not add broadcasts to the count below
        healthy.__pendingTransaction.submitPromise.catch(() => {})
        healthy.stop()

        const hung = makeNode()
        mockRpc.hung.add(HUNG_URL)
        const hungTick = startWorker(hung, TICK)
        await jest.advanceTimersByTimeAsync(20_001)
        expect(hungTick.outcome).toBe('Pre-build contract reads timed out.')
        await jest.advanceTimersByTimeAsync(60_000)

        //one payload in the cluster for this tick: the healthy node's; the hung node signed nothing at all
        expect(nodesManager.broadcast).toHaveBeenCalledTimes(1)
        expect(buildOraclePriceUpdateTransaction).toHaveBeenCalledTimes(1)
        expect(hung.__pendingTransaction).toBe(null)
    })
})
