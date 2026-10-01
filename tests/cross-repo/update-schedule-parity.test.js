/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')

//node-orchestrator confirms a cluster update by deriving the hash the nodes build for it, so both sides must reach the
//same schedule for one envelope: the ticks, the sync timestamp, and per attempt the fee, maxTime and account sequence.
//This suite runs node-orchestrator's own modules from the sibling checkout - update-schedule.js, the real
//getUpdateTxHash of blockchain-data-provider.js and the real getTimestamp of config-manager.js - against this node's
//ClusterRunner and RunnerBase. Without the sibling checkout it fails unless
//SKIP_CROSS_REPO=1 is set

//every build either side makes is recorded and refused, so all three attempts of a round run and nothing lands
const mockChain = {sequence: '0', builds: []}

jest.mock('@reflector/reflector-shared', () => ({
    buildUpdateTransaction: params => {
        mockChain.builds.push(params)
        return Promise.reject(new Error('recorded, not submitted'))
    },
    normalizeTimestamp: (ts, tf) => Math.floor(ts / tf) * tf,
    areAllSignaturesPresent: () => true
}))
jest.mock('../../src/domain/container', () => ({settingsManager: null}))
jest.mock('../../src/domain/nodes/nodes-manager', () => ({broadcast: jest.fn(), sendTo: jest.fn()}))
jest.mock('../../src/domain/statistics-manager', () => ({setLastProcessedTimestamp: jest.fn()}))
jest.mock('../../src/utils', () => ({
    submitTransaction: jest.fn(),
    getAccount: id => Promise.resolve({accountId: () => id, sequenceNumber: () => mockChain.sequence}),
    txTimeoutMessage: 'Transaction timed out',
    isDebugging: () => false,
    withDeadline: promise => promise
}))
jest.mock('../../src/ws-server/nonce-manager', () => ({getNonce: () => 0, setNonce: () => {}, nonceTypes: {}}))

const {describeWithOrchestrator, orch} = require('./orchestrator-sibling')

const orchestratorModules = ['domain/update-schedule.js', 'domain/blockchain-data-provider.js', 'domain/config-manager.js']

const passphrase = 'Test SDF Network ; September 2015'
const systemAccount = Keypair.random().publicKey()
const minute = 60_000
const grid = 2 * minute
const T = 1_800_000_000_000 //on the two-minute grid

/**
 * The chain's system account sequence as either side reads it before a round: it moves between rounds, as other
 * transactions of the system account move it, so a side that reused an old read would build another hash
 * @param {number} tick - the round's tick
 * @returns {string}
 */
function sequenceAt(tick) {
    return String(tick / 1000)
}

/**
 * @param {Array<object>} builds - recorded build parameters of one round
 * @returns {Array<{timestamp: number, account: string, sequence: string, fee: number, maxTime: number, network: string}>}
 */
function attemptsOf(builds) {
    return builds.map(({timestamp, account, fee, maxTime, network, newConfig, currentConfig}) => ({
        timestamp,
        account: account.accountId(),
        sequence: account.sequenceNumber(),
        fee,
        maxTime,
        network,
        newConfig,
        currentConfig
    }))
}

describeWithOrchestrator('the node and the orchestrator derive the same update schedule', orchestratorModules, () => {
    let schedule
    let provider
    let getTimestamp
    let orchestratorSource
    let container
    let ClusterRunner
    let RunnerBase

    beforeAll(() => {
        jest.doMock(orch('logger.js'), () => ({error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}}))
        jest.doMock(orch('domain/container.js'), () => ({
            appConfig: {getNetworkConfig: () => ({urls: ['http://rpc'], passphrase: 'Test SDF Network ; September 2015'})}
        }))
        jest.doMock(orch('persistence-layer/models/contract-config.js'), () => ({}))
        jest.doMock(orch('utils/rpc-helper.js'), () => ({}))
        jest.doMock(orch('domain/nonce-provider.js'), () => ({}))
        jest.doMock(orch('domain/notification-provider.js'), () => ({notify: () => {}}))
        jest.doMock(orch('domain/subscription-data-provider.js'), () => ({setManagers: () => {}}))
        schedule = require(orch('domain/update-schedule.js'))
        provider = require(orch('domain/blockchain-data-provider.js'))
        ;({getTimestamp} = require(orch('domain/config-manager.js')))
        orchestratorSource = fs.readFileSync(orch('domain/config-manager.js'), 'utf8').replace(/\r\n/g, '\n')
        container = require('../../src/domain/container')
        ClusterRunner = require('../../src/domain/runners/cluster-runner')
        RunnerBase = require('../../src/domain/runners/runner-base')
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    test('the node keeps a byte-identical copy of the orchestrator schedule module', () => {
        const own = fs.readFileSync(path.resolve(__dirname, '../../src/domain/runners/update-schedule.js'), 'utf8')
        const theirs = fs.readFileSync(orch('domain/update-schedule.js'), 'utf8')
        expect(own.replace(/\r\n/g, '\n')).toBe(theirs.replace(/\r\n/g, '\n'))
    })

    test('both decide the switch at the same ticks, and the tick equal to the switch time is due', () => {
        const {isUpdateTimeReached} = require('../../src/domain/runners/update-schedule')
        const offGrid = T + minute
        for (const switchTime of [T, offGrid])
            for (const tick of [switchTime - grid, switchTime - 1, switchTime, switchTime + 1, switchTime + minute])
                expect(isUpdateTimeReached(switchTime, tick)).toBe(schedule.isUpdateTimeReached(switchTime, tick))
        expect(isUpdateTimeReached(T, T)).toBe(true)
        expect(isUpdateTimeReached(T, T - 1)).toBe(false)
    })

    //the node skips a round the orchestrator would reject before it ends, so both judge a round's end
    //against the expiration date with one rule
    test('both judge whether a round ends before the expiration date the same way', () => {
        const {endsBeforeExpiration} = require('../../src/domain/runners/update-schedule')
        const offGrid = T + minute
        let agreed = 0
        for (const tick of [T - grid, T, offGrid, T + grid, T + 30 * grid])
            for (const offset of [-grid, 0, 1, 60_000, 60_999, 61_000, 61_001, 90_000, grid, 24 * 60 * minute]) {
                const expirationDate = tick + offset
                expect(endsBeforeExpiration(tick, expirationDate)).toBe(schedule.endsBeforeExpiration(tick, expirationDate))
                expect(endsBeforeExpiration(tick, expirationDate)).toBe(offset >= 61_000)
                agreed++
            }
        expect(agreed).toBe(50)
        expect(endsBeforeExpiration(T, T + 61_000)).toBe(true)
        expect(endsBeforeExpiration(T, T + 60_999)).toBe(false)
    })

    test('the node builds with the orchestrator constants: attempts, fee, maxTime and the sync grid', () => {
        expect(RunnerBase.maxSubmitAttempts).toBe(3)
        expect(RunnerBase.maxSubmitAttempts).toBe(schedule.maxSubmitAttempts)
        expect(RunnerBase.feeMultiplier).toBe(8)
        expect(RunnerBase.feeMultiplier).toBe(schedule.FEE_MULTIPLIER)
        expect(ClusterRunner.baseUpdateFee).toBe(10_000_000)
        expect(ClusterRunner.baseUpdateFee).toBe(provider.baseUpdateFee)
        for (const syncTimestamp of [T, T + minute])
            for (let iteration = 1; iteration <= schedule.maxSubmitAttempts; iteration++)
                expect(RunnerBase.getMaxTime(syncTimestamp, iteration)).toBe(schedule.__getMaxTime(syncTimestamp, iteration))
        expect([1, 2, 3].map(i => RunnerBase.getMaxTime(T, i) - T / 1000)).toEqual([30, 45, 60])
        //the node's idle tick is the orchestrator's sync grid: both retry a failed round at its next tick
        expect(new ClusterRunner().__timeframe).toBe(grid)
        expect(new ClusterRunner().__timeframe).toBe(schedule.syncTimeframe)
    })

    //the orchestrator's gate lives inside processPendingConfig, which it does not export; the model below follows it
    //line for line, and these are the lines it follows, so a change on that side fails here first
    test('the orchestrator gate the model follows is the one in config-manager.js', () => {
        for (const line of [
            'const updateTimeReached = isUpdateTimeReached(__pendingConfig.envelope.timestamp, syncTimestamp)',
            'if (!(updateTimeReached || __pendingConfig.envelope.allowEarlySubmission))',
            'if (minDate && syncTimestamp < minDate) {',
            'if (__pendingConfig.envelope.timestamp > Date.now() && !__pendingConfig.envelope.allowEarlySubmission) {',
            'if (__pendingConfig.expirationDate < Date.now()) {',
            'const accountSequence = await getAccountSequence(__currentConfig.envelope.config)',
            'for (let i = 0; i < maxSubmitAttempts; i++) {',
            'if (!__pendingConfig || __pendingConfig.envelope.allowEarlySubmission || isPendingConfigExpired())',
            'return normalizeTimestamp(timestamp + updateIdleTimeframe, updateIdleTimeframe)',
            'return __pendingConfig.envelope.timestamp < Date.now()',
            'const updateIdleTimeframe = syncTimeframe',
            //the expiry rule is the shared one, and the pending envelope travels with the date it is judged against
            'const {isUpdateTimeReached, syncTimeframe, endsBeforeExpiration} = require(\'./update-schedule\')',
            'if (!endsBeforeExpiration(timestamp, configItem.expirationDate))',
            '? {...__pendingConfig.envelope.toPlainObject(), expirationDate: __pendingConfig.expirationDate}'
        ])
            expect(orchestratorSource).toContain(line)
        expect(orchestratorSource).not.toContain('function endsBeforeExpiration')
        const pollLoop = 'while (maxTime + 1 >= Date.now() / 1000) {'
        expect(orchestratorSource).toContain(pollLoop)
    })

    /**
     * @param {{timestamp: number, allowEarlySubmission: boolean, minDate: number}} envelope - pending envelope; the flags are optional
     * @returns {{config: object, pendingConfig: object}}
     */
    function configsOf({timestamp, allowEarlySubmission = false, minDate = 0}) {
        return {
            config: {nodes: new Map([['A', {}]]), systemAccount, network: 'testnet'},
            pendingConfig: {timestamp, allowEarlySubmission, config: {nodes: new Map([['A', {}]]), minDate}, signatures: []}
        }
    }

    /**
     * The node's side: this node's ClusterRunner at each tick, with its own next-tick rule
     * @param {{config: object, pendingConfig: object}} configs - current and pending config
     * @param {number} expirationDate - the expiration date the orchestrator sends with the pending config; a node holds
     * none when it is not finite
     * @returns {{decide: function(number, number): Promise<object>, next: function(number, number): number}}
     */
    function nodeSide(configs, expirationDate) {
        const runner = new ClusterRunner()
        runner.isRunning = true
        container.settingsManager = {
            ...configs,
            pendingExpirationDate: Number.isFinite(expirationDate) ? expirationDate : null,
            getBlockchainConnectorSettings: () => ({networkPassphrase: passphrase, sorobanRpc: ['http://rpc']}),
            applyPendingUpdate: jest.fn()
        }
        const submit = jest.spyOn(runner, '__buildAndSubmitTransaction')
        const now = jest.spyOn(Date, 'now')
        return {
            async decide(tick, clock) {
                now.mockReturnValue(clock)
                mockChain.builds = []
                submit.mockClear()
                let built = true
                try {
                    built = await runner.__workerFn(tick)
                } catch (err) {
                    expect(err.message).toBe('Failed to submit transaction. See logs for details.')
                }
                if (!built)
                    return {tick, built: false}
                expect(submit).toHaveBeenCalledTimes(1)
                return {tick, built: true, syncTimestamp: submit.mock.calls[0][3], attempts: attemptsOf(mockChain.builds)}
            },
            next(tick, clock) {
                now.mockReturnValue(clock)
                return runner.__getNextTimestamp(tick)
            }
        }
    }

    /**
     * The orchestrator's side: the PENDING branch of processPendingConfig and waitForSuccessfulUpdate, driven by
     * its real update-schedule.js and its real getUpdateTxHash
     * @param {{config: object, pendingConfig: object}} configs - current and pending config
     * @param {number} expirationDate - expiration date of the proposal
     * @returns {{decide: function(number, number): Promise<object>, next: function(number, number): number}}
     */
    function orchestratorSide({config, pendingConfig}, expirationDate) {
        const {timestamp, allowEarlySubmission} = pendingConfig
        return {
            async decide(tick, clock) {
                if (expirationDate < clock)
                    return {tick, built: false, rejected: true}
                const updateTimeReached = schedule.isUpdateTimeReached(timestamp, tick)
                if (!(updateTimeReached || allowEarlySubmission))
                    return {tick, built: false}
                if (!updateTimeReached && pendingConfig.config.minDate && tick < pendingConfig.config.minDate)
                    return {tick, built: false}
                if (timestamp > clock && !allowEarlySubmission)
                    return {tick, built: false}
                mockChain.builds = []
                const accountSequence = mockChain.sequence
                for (let i = 0; i < provider.maxSubmitAttempts; i++)
                    await expect(provider.getUpdateTxHash(config, pendingConfig.config, accountSequence, timestamp, tick, i))
                        .rejects.toThrow('recorded, not submitted')
                return {tick, built: true, syncTimestamp: tick, attempts: attemptsOf(mockChain.builds)}
            },
            next(tick, clock) {
                if (allowEarlySubmission || timestamp < clock)
                    return Math.floor((tick + schedule.syncTimeframe) / schedule.syncTimeframe) * schedule.syncTimeframe
                return timestamp
            }
        }
    }

    /**
     * Walks one side from its first tick until it has built `rounds` rounds or taken `maxSteps` steps. Each round fails,
     * as every attempt is refused, and ends where the orchestrator's last poll of it ends
     * @param {{decide: function, next: function}} side - node or orchestrator
     * @param {number} startClock - clock when the side starts; its first tick is the grid tick at or before it
     * @param {function(number, number): number} clockAt - clock when the tick of a step fires
     * @param {number} rounds - built rounds to walk
     * @returns {Promise<Array<object>>}
     */
    async function walk(side, startClock, clockAt, rounds) {
        const trace = []
        let tick = Math.floor(startClock / grid) * grid
        for (let step = 0; step < 8 && trace.filter(entry => entry.built).length < rounds; step++) {
            const clock = clockAt(tick, step)
            mockChain.sequence = sequenceAt(tick)
            const decision = await side.decide(tick, clock)
            trace.push(decision)
            //a failed round ends when its last attempt has expired and the orchestrator's last poll is over
            tick = side.next(tick, decision.built ? tick + minute + 1000 : clock)
        }
        return trace
    }

    /**
     * @param {{timestamp: number, allowEarlySubmission: boolean, minDate: number}} envelope - pending envelope; the flags are optional
     * @param {object} options - the walk: startClock, and optionally clockAt(tick, step), rounds and expirationDate
     * @returns {Promise<{node: Array<object>, orchestrator: Array<object>}>}
     */
    async function bothSides(envelope, {startClock, clockAt = tick => tick + 5, rounds = 2, expirationDate = Infinity}) {
        const configs = configsOf(envelope)
        const node = await walk(nodeSide(configs, expirationDate), startClock, clockAt, rounds)
        jest.restoreAllMocks()
        const orchestrator = await walk(orchestratorSide(configs, expirationDate), startClock, clockAt, rounds)
        return {node, orchestrator}
    }

    /**
     * @param {object} round - a built round of a trace
     * @param {number} switchTime - the envelope's switch time
     * @param {number} syncTimestamp - the tick the round runs at
     */
    function expectRound(round, switchTime, syncTimestamp) {
        expect(round.built).toBe(true)
        expect(round.syncTimestamp).toBe(syncTimestamp)
        expect(round.attempts.map(({fee}) => fee)).toEqual([10_000_000, 80_000_000, 640_000_000])
        expect(round.attempts.map(({maxTime}) => maxTime * 1000 - syncTimestamp)).toEqual([30_000, 45_000, 60_000])
        expect(round.attempts.map(({timestamp}) => timestamp)).toEqual([switchTime, switchTime, switchTime])
        expect(round.attempts.map(({sequence}) => sequence)).toEqual(Array(3).fill(sequenceAt(syncTimestamp)))
        expect(round.attempts.map(({account}) => account)).toEqual(Array(3).fill(systemAccount))
        expect(round.attempts.map(({network}) => network)).toEqual(Array(3).fill(passphrase))
    }

    test('a switch time on the grid: both build at it with it as the sync timestamp, and retry at the next tick', async () => {
        const switchTime = getTimestamp(T)
        expect(switchTime).toBe(T)

        const {node, orchestrator} = await bothSides({timestamp: switchTime}, {startClock: T - 4 * minute - 10_000})

        expect(node).toEqual(orchestrator)
        expect(node.map(({tick, built}) => [tick - T, built])).toEqual([[-6 * minute, false], [0, true], [grid, true]])
        expectRound(node[1], T, T)
        expectRound(node[2], T, T + grid)
    })

    test('an off-grid explicit time is rounded up by the orchestrator, and both build at the rounded time', async () => {
        const switchTime = getTimestamp(T - 30_000)
        expect(switchTime).toBe(T)

        const {node, orchestrator} = await bothSides({timestamp: switchTime}, {startClock: T - 90_000})

        expect(node).toEqual(orchestrator)
        expect(node.map(({tick, built}) => [tick - T, built])).toEqual([[-grid, false], [0, true], [grid, true]])
        expectRound(node[1], T, T)
        expectRound(node[2], T, T + grid)
    })

    //a PENDING envelope stored before this release keeps its old odd-minute switch time; the release window rules
    //it out, but if one survives both sides still agree on every hash
    test('a legacy odd-minute switch time: both build at it and retry at the next grid tick', async () => {
        const switchTime = T + minute

        const {node, orchestrator} = await bothSides({timestamp: switchTime}, {startClock: T - 10_000})

        expect(node).toEqual(orchestrator)
        expect(node.map(({tick, built}) => [tick - T, built])).toEqual([[-grid, false], [minute, true], [grid, true]])
        expectRound(node[1], switchTime, switchTime)
        expectRound(node[2], switchTime, T + grid)
    })

    test('early submission with minDate between two ticks: both refuse the tick before it and build at the next', async () => {
        const minDate = T + minute
        const envelope = {timestamp: T + 60 * minute, allowEarlySubmission: true, minDate}

        const {node, orchestrator} = await bothSides(envelope, {startClock: T - 10_000})

        expect(node).toEqual(orchestrator)
        const decisions = [[-grid, false], [0, false], [grid, true], [2 * grid, true]]
        expect(node.map(({tick, built}) => [tick - T, built])).toEqual(decisions)
        expectRound(node[2], envelope.timestamp, T + grid)
        expectRound(node[3], envelope.timestamp, T + 2 * grid)
    })

    //the wall-clock guard: a timer that fires early - by a millisecond, or by weeks for a delay the timer could not hold -
    //enters with the switch-time tick before that time; both abstain and re-arm for the switch time
    test('the switch-time tick entered before the switch time: both abstain, re-arm for it and build there', async () => {
        const early = [T - 30 * 24 * 60 * minute, T - 1]
        const clockAt = (tick, step) => (tick === T && step <= 2 ? early[step - 1] : tick + 5)

        const {node, orchestrator} = await bothSides({timestamp: T}, {startClock: T - 10_000, clockAt, rounds: 1})

        expect(node).toEqual(orchestrator)
        expect(node.map(({tick, built}) => [tick - T, built])).toEqual([[-grid, false], [0, false], [0, false], [0, true]])
        expectRound(node[3], T, T)
    })

    test('a switch time 61 s before expiry: the round ends exactly as the proposal expires, a second less is refused', async () => {
        const expirationDate = T + 61_000
        //the shared rule: the last attempt's maxTime and the orchestrator's last poll a second later
        expect(schedule.endsBeforeExpiration(T, expirationDate)).toBe(true)
        expect(schedule.endsBeforeExpiration(T, expirationDate - 1)).toBe(false)

        const {node, orchestrator} = await bothSides({timestamp: T}, {startClock: T - 10_000, rounds: 1, expirationDate})

        expect(node).toEqual(orchestrator)
        expectRound(node[1], T, T)
        const lastAttempt = node[1].attempts[schedule.maxSubmitAttempts - 1]
        expect(lastAttempt.maxTime * 1000 + 1000).toBe(expirationDate)
    })

    //the expired-update race: the first round fits before the expiration date, its retry at the next tick
    //does not. The orchestrator rejects the update when it wakes at that tick; the node, told the date, builds no retry
    //the orchestrator would not watch
    test('a proposal expiring between the switch time and the retry tick: both build the first round, neither the retry', async () => {
        const expirationDate = T + 90_000

        const {node, orchestrator} = await bothSides({timestamp: T}, {startClock: T - 10_000, rounds: 2, expirationDate})

        expect(node.map(({tick, built}) => [tick - T, built])).toEqual(orchestrator.map(({tick, built}) => [tick - T, built]))
        expect(node.filter(entry => entry.built).map(entry => entry.tick)).toEqual([T])
        expect(node.map(({tick, built}) => [tick - T, built]).slice(0, 3)).toEqual([[-grid, false], [0, true], [grid, false]])
        expect(orchestrator[2]).toEqual({tick: T + grid, built: false, rejected: true})
        expectRound(node[1], T, T)
        expect(node[1]).toEqual(orchestrator[1])
    })
})
