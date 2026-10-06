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
    //runner-base destructures withDeadline at require time; a pass-through keeps the reads and the build unbounded here
    withDeadline: promise => promise
}))
jest.mock('../../../src/ws-server/nonce-manager', () => ({
    getNonce: jest.fn(() => 1),
    setNonce: jest.fn(),
    nonceTypes: {CONFIG: 'config', PENDING_CONFIG: 'pendingConfig', GATEWAYS: 'gateways'}
}))

const {areAllSignaturesPresent} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const ClusterRunner = require('../../../src/domain/runners/cluster-runner')

const switchTime = 1_700_000_100_000

/**
 * @param {number} timestamp - scheduled switch time of the pending config
 * @param {{allowEarlySubmission: boolean, minDate: number}} [options] - early-submission fields of the pending config
 */
function installSettings(timestamp, {allowEarlySubmission = false, minDate = 0} = {}) {
    container.settingsManager = {
        config: {nodes: new Map([['A', {}]]), systemAccount: 'GSYS'},
        pendingConfig: {
            timestamp,
            allowEarlySubmission,
            config: {nodes: new Map([['A', {}]]), minDate},
            signatures: []
        },
        getBlockchainConnectorSettings: () => ({networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpc: ['http://rpc']}),
        applyPendingUpdate: jest.fn()
    }
}

describe('ClusterRunner switch time', () => {
    afterEach(() => {
        jest.restoreAllMocks()
    })

    test('a cluster round lasts 60 s on the 120 s idle grid', () => {
        const runner = new ClusterRunner()
        expect(runner.__roundLength).toBe(60_000)
        expect(runner.__timeframe).toBe(120_000)
    })

    //the node and node-orchestrator decide the switch with one rule (the shared update schedule, checked end to end by
    //tests/cross-repo/update-schedule-parity.test.js), so both build the update at the tick equal to its switch time
    test('the tick that fires exactly at the switch time builds and applies the update with that tick', async () => {
        installSettings(switchTime)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(async () => null)
        //the worker runs once the switch-time tick has fired, so the pending config already reads as expired
        jest.spyOn(Date, 'now').mockReturnValue(switchTime + 1)

        const processed = await runner.__workerFn(switchTime)

        expect(processed).toBe(true)
        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        expect(runner.__buildAndSubmitTransaction.mock.calls[0][3]).toBe(switchTime)
        expect(container.settingsManager.applyPendingUpdate).toHaveBeenCalledTimes(1)
    })

    //an overflowed or otherwise early timer can enter the worker with the switch-time tick before that time; under the
    //inclusive rule it would build the update early, so the node's clock decides to abstain, as node-orchestrator's
    //config-manager.js does
    test('the switch-time tick entered before the switch time on this node clock builds nothing', async () => {
        installSettings(switchTime)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve(null))
        jest.spyOn(Date, 'now').mockReturnValue(switchTime - 30 * 24 * 60 * 60 * 1000)

        const processed = await runner.__workerFn(switchTime)

        expect(processed).toBe(false)
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(container.settingsManager.applyPendingUpdate).not.toHaveBeenCalled()
    })

    test('a timer one millisecond early abstains and re-arms for the same switch time', async () => {
        installSettings(switchTime)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve(null))
        jest.spyOn(Date, 'now').mockReturnValue(switchTime - 1)

        expect(await runner.__workerFn(switchTime)).toBe(false)
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        expect(runner.__getNextTimestamp(switchTime)).toBe(switchTime)
    })

    test('no pending config builds nothing and does not throw', async () => {
        installSettings(switchTime)
        container.settingsManager.pendingConfig = null
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve(null))

        expect(await runner.__workerFn(switchTime)).toBe(false)
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })

    //node-orchestrator skips its wall-clock guard for an early submission (config-manager.js), so the node does too:
    //a grid tick at or past the switch time builds even while this node's clock is still behind it
    test('an early submission whose tick reached the switch time builds while the clock is still behind it', async () => {
        installSettings(switchTime, {allowEarlySubmission: true})
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve(null))
        jest.spyOn(Date, 'now').mockReturnValue(switchTime - 1000)

        expect(await runner.__workerFn(switchTime)).toBe(true)
        expect(runner.__buildAndSubmitTransaction.mock.calls[0][3]).toBe(switchTime)
    })

    //node-orchestrator derives the hash from the tick it woke with (config-manager.js processPendingConfig), so the node
    //builds with its tick too - also when the clock reads exactly the switch time and the tick is a later one
    test('the update is built with the tick, not the switch time, when the clock reads exactly the switch time', async () => {
        installSettings(switchTime)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(() => Promise.resolve(null))
        jest.spyOn(Date, 'now').mockReturnValue(switchTime)
        const laterTick = switchTime + 60_000

        expect(await runner.__workerFn(laterTick)).toBe(true)
        expect(runner.__buildAndSubmitTransaction.mock.calls[0][3]).toBe(laterTick)
    })

    test('the next tick after the switch time applies the update with that tick as the sync timestamp', async () => {
        installSettings(switchTime)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn().mockResolvedValue(null)
        //the runner re-arms right after the switch-time tick has fired, so the pending config reads as expired
        jest.spyOn(Date, 'now').mockReturnValue(switchTime + 1)

        const nextTick = runner.__getNextTimestamp(switchTime)
        const processed = await runner.__workerFn(nextTick)

        //a switch tick that did not land is retried at the next idle tick, which this fixture's odd-minute switch time
        //puts one minute later on the two-minute grid - the orchestrator's next sync tick after a failed attempt too
        expect(nextTick).toBe(switchTime + 60_000)
        expect(processed).toBe(true)
        expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        expect(runner.__buildAndSubmitTransaction.mock.calls[0][3]).toBe(switchTime + 60_000)
        expect(container.settingsManager.applyPendingUpdate).toHaveBeenCalledTimes(1)
    })

    describe('early submission waits for the signed minDate, judged on the tick', () => {
        const evenTick = 1_700_000_040_000 //on the two-minute grid both sides tick on
        const minDate = evenTick + 1000 //second-rounded, just past the tick
        const farSwitch = evenTick + 60 * 60 * 1000 //the derived slot is an hour away, so only early submission can build

        /**
         * @param {number} tick - tick the runner fires for
         * @param {number} now - local clock when it fires
         * @returns {Promise<{processed: boolean, runner: ClusterRunner}>}
         */
        async function fire(tick, now) {
            installSettings(farSwitch, {allowEarlySubmission: true, minDate})
            areAllSignaturesPresent.mockReturnValueOnce(true)
            jest.spyOn(Date, 'now').mockReturnValue(now)
            const runner = new ClusterRunner()
            runner.__buildAndSubmitTransaction = jest.fn().mockResolvedValue(null)
            const processed = await runner.__workerFn(tick)
            return {processed, runner}
        }

        test('a tick before minDate does not build, even when it fires late enough for the clock to be past minDate', async () => {
            const {processed, runner} = await fire(evenTick, minDate + 5000)

            expect(processed).toBe(false)
            expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
        })

        test('the first tick at or after minDate builds with that tick as the sync timestamp, whatever the clock reads', async () => {
            const nextTick = evenTick + 120_000
            //a clock running behind the tick must not hold the node back when the orchestrator builds at that tick
            const {processed, runner} = await fire(nextTick, minDate - 5000)

            expect(processed).toBe(true)
            expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
            expect(runner.__buildAndSubmitTransaction.mock.calls[0][3]).toBe(nextTick)
        })

        test('a tick exactly at minDate builds', async () => {
            installSettings(farSwitch, {allowEarlySubmission: true, minDate: evenTick})
            areAllSignaturesPresent.mockReturnValueOnce(true)
            jest.spyOn(Date, 'now').mockReturnValue(evenTick - 1)
            const runner = new ClusterRunner()
            runner.__buildAndSubmitTransaction = jest.fn().mockResolvedValue(null)

            expect(await runner.__workerFn(evenTick)).toBe(true)
            expect(runner.__buildAndSubmitTransaction).toHaveBeenCalledTimes(1)
        })
    })

    test('a tick before the switch time still waits', async () => {
        installSettings(switchTime)
        const runner = new ClusterRunner()
        runner.__buildAndSubmitTransaction = jest.fn(async () => null)

        const processed = await runner.__workerFn(switchTime - 1)

        expect(processed).toBe(false)
        expect(runner.__buildAndSubmitTransaction).not.toHaveBeenCalled()
    })
})
