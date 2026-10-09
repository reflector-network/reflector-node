/*eslint-disable no-undef */
const {evaluateHealth} = require('./health')

const now = 1_800_000_400_000
const config = {contracts: {
    O1: {type: 'oracle', timeframe: 300000},
    B1: {type: 'oracle_beam', timeframe: 60000}
}}

function input(overrides = {}) {
    return {
        config,
        hash: 'H',
        statistics: {nodeStatistics: {A: {currentConfigHash: 'H', pendingConfigHash: null}, B: {currentConfigHash: 'H', pendingConfigHash: null}}},
        runningMembers: ['A', 'B'],
        oracleStates: {O1: {lastTimestamp: now - 300000}},
        now,
        errorLines: [],
        nodeStarts: {0: now - 3600000},
        ...overrides
    }
}

describe('evaluateHealth', () => {
    test('a converged cluster with fresh oracles is healthy; beams are not judged', () => {
        expect(evaluateHealth(input())).toEqual({ok: true, problems: [], notes: []})
    })

    test('a node on another config or holding a pending update is reported', () => {
        const statistics = {nodeStatistics: {
            A: {currentConfigHash: 'X', pendingConfigHash: null},
            B: {currentConfigHash: 'H', pendingConfigHash: 'P'}
        }}
        const result = evaluateHealth(input({statistics}))
        expect(result.ok).toBe(false)
        expect(result.problems).toEqual(['A is on config X, expected H', 'B holds pending config P'])
    })

    test('a running member without statistics is reported', () => {
        expect(evaluateHealth(input({runningMembers: ['A', 'B', 'C']})).problems).toEqual(['C sends no statistics'])
    })

    test('an oracle that missed a tick is reported', () => {
        expect(evaluateHealth(input({oracleStates: {O1: {lastTimestamp: now - 700000}}})).problems).toEqual(['oracle O1 last updated 700 s ago'])
    })

    test('known startup errors within two minutes of a start are allowed, other errors are not', () => {
        const nodeStarts = {0: now - 60000}
        const errorLines = [
            {index: 0, entry: {level: 'error', time: new Date(now - 30000).toISOString(), msg: 'Tx timed out.'}},
            {index: 0, entry: {
                level: 'error', time: new Date(now - 30000).toISOString(), msg: 'Error in worker',
                err: {message: 'Failed to submit transaction. See logs for details.'}
            }},
            {index: 0, entry: {level: 'error', time: new Date(now - 25000).toISOString(), msg: 'HostError: Error(Contract, #5)\n\nEvent log (newest first):'}},
            {index: 0, entry: {level: 'error', time: new Date(now - 20000).toISOString(), msg: 'Unexpected failure'}}
        ]
        expect(evaluateHealth(input({nodeStarts, errorLines})).problems).toEqual(['node0 error: Unexpected failure'])
    })

    test('errors from an unreachable data-source RPC are notes, not problems', () => {
        const at = new Date(now - 1000).toISOString()
        const errorLines = [
            {index: 0, entry: {level: 'error', time: at, msg: 'Error fetching transactions', err: {message: 'Failed to invoke RPC method on all provided URLs'}}},
            {index: 0, entry: {level: 'error', time: at, msg: 'Pool discovery failed', network: 'Public Global Stellar Network ; September 2015'}},
            {index: 1, entry: {level: 'error', time: at, msg: 'Error loading prices for source', source: 'pubnet', err: {message: 'Price data request for pubnet timed out after 121500 ms'}}}
        ]
        const result = evaluateHealth(input({errorLines}))
        expect(result.ok).toBe(true)
        expect(result.notes).toEqual([
            'node0 environment: Error fetching transactions (Failed to invoke RPC method on all provided URLs)',
            'node0 environment: Pool discovery failed',
            'node1 environment: Error loading prices for source (Price data request for pubnet timed out after 121500 ms)'
        ])
    })

    test('startup errors right after a cluster-wide start, such as a contract added by a config switch, are allowed on every node', () => {
        const errorLines = [
            {index: 1, entry: {level: 'error', time: new Date(now - 1000).toISOString(), msg: 'Tx timed out.'}},
            {index: 2, entry: {level: 'error', time: new Date(now - 1000).toISOString(), msg: 'Unexpected failure'}}
        ]
        const result = evaluateHealth(input({errorLines, clusterStarts: [now - 30000]}))
        expect(result.problems).toEqual(['node2 error: Unexpected failure'])
    })

    test('a peer that cannot be reached right after another node restarted is allowed', () => {
        const nodeStarts = {0: now - 3600000, 3: now - 40000}
        const errorLines = [
            {index: 0, entry: {level: 'error', time: new Date(now - 30000).toISOString(), msg: 'Error sending state message', err: 'Channel 2 is not ready'}}
        ]
        expect(evaluateHealth(input({nodeStarts, errorLines})).problems).toEqual([])
    })

    test('a peer that cannot be reached while another node is being stopped for a restart is allowed', () => {
        const nodeStarts = {0: now - 3600000, 3: now - 40000}
        const errorLines = [
            {index: 0, entry: {level: 'error', time: new Date(now - 40500).toISOString(), msg: 'Error sending state message', err: 'Channel 2 is not ready'}}
        ]
        expect(evaluateHealth(input({nodeStarts, errorLines})).problems).toEqual([])
    })

    test('submission errors inside a window a scenario declared, such as an outage it caused, are allowed', () => {
        const errorLines = [
            {index: 0, entry: {level: 'error', time: new Date(now - 200000).toISOString(), msg: 'Tx timed out.'}},
            {index: 0, entry: {level: 'error', time: new Date(now - 10000).toISOString(), msg: 'Tx timed out.'}}
        ]
        const result = evaluateHealth(input({errorLines, graceWindows: [{from: now - 300000, to: now - 100000}]}))
        expect(result.problems).toEqual(['node0 error: Tx timed out.'])
    })

    test('a window declared for one node allows its submission errors and no other node\'s', () => {
        const at = new Date(now - 10000).toISOString()
        const errorLines = [
            {index: 3, entry: {level: 'error', time: at, msg: 'Tx timed out.'}},
            {index: 1, entry: {level: 'error', time: at, msg: 'Tx timed out.'}}
        ]
        const result = evaluateHealth(input({errorLines, graceWindows: [{from: now - 60000, to: now, index: 3}]}))
        expect(result.problems).toEqual(['node1 error: Tx timed out.'])
    })

    test('missing trades data right after a start is allowed: the node has not gathered its peers\' data yet', () => {
        const nodeStarts = {3: now - 20000}
        const errorLines = [{index: 3, entry: {
            level: 'error', time: new Date(now - 1000).toISOString(), msg: 'Error in worker',
            err: {message: 'Trades data not found for contract O1 for timestamp 1'}
        }}]
        expect(evaluateHealth(input({nodeStarts, errorLines})).problems).toEqual([])
    })

    test('a request to a restarting peer that times out is allowed in a start window', () => {
        const errorLines = [{index: 0, entry: {
            level: 'error', time: new Date(now - 1000).toISOString(), msg: 'Error sending message 7 to GD3CE7O6',
            err: {message: 'Request timed out after 5000. Message: 7.'}
        }}]
        expect(evaluateHealth(input({errorLines, clusterStarts: [now - 20000]})).problems).toEqual([])
    })

    test('the startup window lasts until a node has a full oracle timeframe of trades data', () => {
        //O1 prices from five minutes of trades: a node that started three minutes ago cannot agree with its peers yet
        const nodeStarts = {0: now - 3600000, 2: now - 170000}
        const errorLines = [{index: 2, entry: {level: 'error', time: new Date(now - 1000).toISOString(), msg: 'Tx timed out.'}}]
        expect(evaluateHealth(input({nodeStarts, errorLines})).problems).toEqual([])
        const late = {0: now - 3600000, 2: now - 8 * 60000}
        expect(evaluateHealth(input({nodeStarts: late, errorLines})).problems).toEqual(['node2 error: Tx timed out.'])
    })

    test('the same startup error long after a start is reported', () => {
        const errorLines = [{index: 0, entry: {level: 'error', time: new Date(now - 1000).toISOString(), msg: 'Tx timed out.'}}]
        expect(evaluateHealth(input({errorLines})).problems).toEqual(['node0 error: Tx timed out.'])
    })
})

describe('checkHealth', () => {
    test('error lines of a node that is no longer a member are not judged', async () => {
        jest.resetModules()
        jest.doMock('./flow', () => ({
            current: () => Promise.resolve({raw: {nodes: {A: {}}, contracts: {}}, hash: 'H'}),
            runningMembers: () => Promise.resolve(['A'])
        }))
        jest.doMock('./env', () => ({
            listNodes: () => [{index: 0, pubkey: 'A'}, {index: 3, pubkey: 'GONE'}]
        }))
        const {checkHealth} = require('./health')
        const at = new Date().toISOString()
        const ctx = {
            wait: fn => Promise.resolve(fn()),
            orch: {statistics: () => Promise.resolve({nodeStatistics: {A: {currentConfigHash: 'H', pendingConfigHash: null}}})},
            chain: {},
            nodes: {
                startTimes: () => ({}),
                readLogLines: index => (index === 3 ? [{level: 'error', time: at, msg: 'Request timed out after 5000'}] : [])
            }
        }
        expect(await checkHealth(ctx, {since: 0})).toEqual({ok: true, problems: [], notes: []})
        jest.dontMock('./flow')
        jest.dontMock('./env')
    })
})

describe('evaluateHealth, review fixes', () => {
    const pubnetConfig = {contracts: {
        O1: {type: 'oracle', timeframe: 300000, dataSource: 'exchanges'},
        P1: {type: 'oracle', timeframe: 300000, dataSource: 'pubnet'}
    }}
    const fresh = {O1: {lastTimestamp: now - 300000}, P1: {lastTimestamp: now - 300000}}
    const at = new Date(now - 1000).toISOString()
    const worker = message => ({level: 'error', time: at, msg: 'Error in worker', err: {message}})

    test('an RPC failure outside the pubnet data source is a problem, not an environment note', () => {
        const errorLines = [{index: 0, entry: worker('Failed to invoke RPC method on all provided URLs')}]
        expect(evaluateHealth(input({config: pubnetConfig, oracleStates: fresh, errorLines})).problems)
            .toEqual(['node0 error: Error in worker'])
    })

    test('missing trades data is an environment note for a pubnet oracle and a problem for any other', () => {
        const errorLines = [
            {index: 0, entry: worker('Trades data not found for contract P1 for timestamp 1')},
            {index: 1, entry: worker('Trades data not found for contract O1 for timestamp 1')}
        ]
        const result = evaluateHealth(input({config: pubnetConfig, oracleStates: fresh, errorLines}))
        expect(result.problems).toEqual(['node1 error: Error in worker'])
        expect(result.notes).toEqual(['node0 environment: Error in worker (Trades data not found for contract P1 for timestamp 1)'])
    })

    test('a price provider whose upstream request failed is an environment note; any other provider error is a problem', () => {
        const provider = (name, error) => ({level: 'error', time: at, msg: 'Error getting trade data', provider: name, error})
        const errorLines = [
            {index: 0, entry: provider('ecb', 'Request to data-api.ecb.europa.eu failed: ERR_CANCELED')},
            {index: 1, entry: provider('binance', 'Unexpected response shape')}
        ]
        const result = evaluateHealth(input({config: pubnetConfig, oracleStates: fresh, errorLines}))
        expect(result.notes).toEqual(['node0 environment: Error getting trade data (Request to data-api.ecb.europa.eu failed: ERR_CANCELED)'])
        expect(result.problems).toEqual(['node1 error: Error getting trade data'])
    })

    test('a declared window may allow further patterns', () => {
        const errorLines = [{index: 1, entry: worker('Trades data not found for contract O1 for timestamp 1')}]
        const graceWindows = [{from: now - 60000, to: now, patterns: [/^Trades data not found for contract/]}]
        expect(evaluateHealth(input({config: pubnetConfig, oracleStates: fresh, errorLines, graceWindows})).problems).toEqual([])
    })

    test('a member whose container is not running is a problem', () => {
        expect(evaluateHealth(input({stoppedMembers: ['C']})).problems).toEqual(['C is a member but not running'])
    })

    test('a running member that stopped processing an oracle is a problem unless it just started', () => {
        const statistics = {nodeStatistics: {
            A: {currentConfigHash: 'H', pendingConfigHash: null, oracleStatistics: {O1: {lastProcessedTimestamp: now - 900000}}},
            B: {currentConfigHash: 'H', pendingConfigHash: null, oracleStatistics: {O1: {lastProcessedTimestamp: now - 300000}}}
        }}
        expect(evaluateHealth(input({statistics, memberIndexes: {A: 0, B: 1}})).problems).toEqual(['A last processed oracle O1 900 s ago'])
        expect(evaluateHealth(input({statistics, memberIndexes: {A: 0, B: 1}, nodeStarts: {0: now - 60000}})).problems).toEqual([])
    })
})

describe('checkHealth, review fixes', () => {
    test('a failure to observe the cluster is an unhealthy result, not a throw', async () => {
        jest.resetModules()
        jest.doMock('./flow', () => ({current: () => Promise.reject(new Error('GET /config failed: ECONNREFUSED'))}))
        const {checkHealth} = require('./health')
        const ctx = {wait: fn => Promise.resolve(fn()), nodes: {startTimes: () => ({})}}
        const result = await checkHealth(ctx, {since: 0})
        expect(result.ok).toBe(false)
        expect(result.problems[0]).toContain('ECONNREFUSED')
        jest.dontMock('./flow')
    })
})
