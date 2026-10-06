/*eslint-disable no-undef */

jest.mock('@reflector/reflector-shared', () => ({
    ...jest.requireActual('@reflector/reflector-shared/utils/update-schedule'),
    buildUpdateTransaction: jest.fn(async () => null),
    normalizeTimestamp: (ts, tf) => Math.floor(ts / tf) * tf,
    areAllSignaturesPresent: jest.fn(() => false)
}))
jest.mock('../../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../../src/utils', () => ({
    submitTransaction: jest.fn(),
    getAccount: jest.fn(async () => ({accountId: () => 'GACCOUNT', sequenceNumber: () => '1'})),
    txTimeoutMessage: 'Transaction timed out',
    isDebugging: () => false,
    withDeadline: promise => promise
}))
jest.mock('../../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 1),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways'}
}))

const container = require('../../../src/domain/container')
const ClusterRunner = require('../../../src/domain/runners/cluster-runner')

const minute = 60 * 1000
const day = 24 * 60 * minute
const start = 1_800_000_000_000 //on the two-minute grid

function pendingAt(timestamp) {
    return {timestamp, allowEarlySubmission: false, config: {nodes: new Map([['A', {}]]), minDate: 0}, signatures: []}
}

//the runner sleeps until the switch time of the pending update; a vote that withdraws that update, or replaces it with
//one due sooner, must end the wait, or the node builds no cluster update until the old switch time
describe('ClusterRunner follows the pending config while it waits', () => {
    let runner

    beforeEach(() => {
        jest.useFakeTimers({now: start + 10 * 1000})
        container.settingsManager = {
            config: {nodes: new Map([['A', {}]]), systemAccount: 'GSYS'},
            pendingConfig: pendingAt(start + 10 * day),
            getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']}),
            applyPendingUpdate: jest.fn()
        }
        runner = new ClusterRunner()
        jest.spyOn(runner, '__workerFn')
        runner.start()
    })

    afterEach(() => {
        runner.stop()
        jest.clearAllTimers()
        jest.useRealTimers()
        jest.restoreAllMocks()
    })

    test('a far switch time is waited for while its update stays pending', async () => {
        await jest.advanceTimersByTimeAsync(minute)
        const calls = runner.__workerFn.mock.calls.length

        await jest.advanceTimersByTimeAsync(30 * minute)

        expect(runner.__workerFn).toHaveBeenCalledTimes(calls)
    })

    test('when the update is cleared, the next idle tick runs within a few minutes', async () => {
        await jest.advanceTimersByTimeAsync(minute)
        const calls = runner.__workerFn.mock.calls.length
        container.settingsManager.pendingConfig = null

        await jest.advanceTimersByTimeAsync(4 * minute)

        expect(runner.__workerFn.mock.calls.length).toBeGreaterThan(calls)
    })

    test('when another update due sooner becomes pending, its switch-time tick runs', async () => {
        await jest.advanceTimersByTimeAsync(minute)
        const near = start + 10 * minute
        container.settingsManager.pendingConfig = pendingAt(near)

        await jest.advanceTimersByTimeAsync(near - Date.now() + 2000)

        expect(runner.__workerFn.mock.calls.map(call => call[0])).toContain(near)
    })
})
