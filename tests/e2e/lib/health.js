const {short} = require('./wait')

//errors a node logs right after it starts, while it catches up with a tick whose deadline already passed or that its
//peers already landed (contract errors #0 and #5), and before it has gathered its peers' trades data
const startupErrors = [/^Tx timed out\.$/, /^Failed to submit transaction/, /^Transaction submit failed/, /HostError: Error\(Contract, #[05]\)/,
    /^Error sending state message$/, /^Error sending message \d+ to /, /^Trades data not found for contract/]
const startGraceMs = 120000
const stopMarginMs = 30000

function matches(entry, patterns) {
    const texts = [entry.msg, entry.err?.message].filter(Boolean)
    return texts.some(text => patterns.some(pattern => pattern.test(text)))
}

/**
 * Errors that only say the pubnet data source's RPC did not answer: the test environment, not the change under test.
 * The same words from the node's own network path or about another oracle stay problems
 * @param {object} entry - log entry
 * @param {Set<string>} pubnetOracles - contract ids of the oracles priced from pubnet
 * @returns {boolean}
 */
function isEnvironmentError(entry, pubnetOracles) {
    const message = entry.err?.message || ''
    if (entry.msg === 'Error fetching transactions' || entry.msg === 'Pool discovery failed')
        return true
    if (entry.msg === 'Error loading prices for source')
        return entry.source === 'pubnet'
    const missing = /^Trades data not found for contract (\w+)/.exec(message)
    return !!missing && pubnetOracles.has(missing[1])
}

function describe(entry) {
    return `${entry.msg}${entry.err?.message ? ` (${entry.err.message})` : ''}`
}

/**
 * @param {object} input - config, hash, statistics, runningMembers, stoppedMembers, memberIndexes ({pubkey: index}),
 * oracleStates, now, errorLines, nodeStarts, clusterStarts (times every node started something new, such as the
 * runner of a contract a config switch added) and graceWindows ({from, to, index?, patterns?} spans a scenario declared)
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
function evaluateHealth(input) {
    const {config, hash, statistics, runningMembers, oracleStates, now, errorLines, nodeStarts} = input
    const {clusterStarts = [], graceWindows = [], stoppedMembers = [], memberIndexes = {}} = input
    const problems = []
    const notes = []
    const oracles = Object.entries(config.contracts).filter(([, c]) => c.type === 'oracle')
    const pubnetOracles = new Set(oracles.filter(([, c]) => c.dataSource === 'pubnet').map(([id]) => id))
    const starts = [...Object.values(nodeStarts), ...clusterStarts]
    //a node that just started prices from fewer minutes than its peers until it holds a full oracle timeframe of trades
    //data, so its first ticks can disagree with the majority; a start is recorded once docker returns, after the node
    //was already stopped for it
    const startGrace = Math.max(0, ...oracles.map(([, c]) => c.timeframe)) + startGraceMs
    const startWindows = starts.map(start => ({from: start - stopMarginMs, to: start + startGrace}))

    for (const pubkey of stoppedMembers)
        problems.push(`${short(pubkey)} is a member but not running`)
    for (const pubkey of runningMembers) {
        const stats = statistics?.nodeStatistics?.[pubkey]
        if (!stats) {
            problems.push(`${short(pubkey)} sends no statistics`)
            continue
        }
        if (stats.currentConfigHash !== hash)
            problems.push(`${short(pubkey)} is on config ${short(stats.currentConfigHash)}, expected ${short(hash)}`)
        if (stats.pendingConfigHash)
            problems.push(`${short(pubkey)} holds pending config ${short(stats.pendingConfigHash)}`)
        //a node that stops signing logs nothing; its own processed timestamps are what show it
        const started = nodeStarts[memberIndexes[pubkey]] || 0
        if (!stats.oracleStatistics)
            continue
        for (const [contractId, contract] of oracles) {
            const allowance = 2 * contract.timeframe + 90000
            if (now - started < allowance + startGraceMs)
                continue
            const processed = stats.oracleStatistics[contractId]?.lastProcessedTimestamp || 0
            if (now - processed > allowance)
                problems.push(`${short(pubkey)} last processed oracle ${short(contractId)} ${processed ? Math.round((now - processed) / 1000) + ' s ago' : 'never'}`)
        }
    }
    for (const [contractId, contract] of oracles) {
        const state = oracleStates[contractId]
        const age = state ? now - state.lastTimestamp : null
        if (age === null || age > 2 * contract.timeframe + 90000)
            problems.push(`oracle ${short(contractId)} last updated ${age === null ? 'never' : Math.round(age / 1000) + ' s ago'}`)
    }
    for (const {index, entry} of errorLines) {
        const time = Date.parse(entry.time)
        const inside = ({from, to}) => time >= from && time < to
        //any node's start opens the window on every node: its peers fail to reach it while it comes up
        if (startWindows.some(inside) && matches(entry, startupErrors))
            continue
        const declared = graceWindows.filter(w => (w.index === undefined || w.index === index) && inside(w))
        if (declared.some(w => matches(entry, [...startupErrors, ...(w.patterns || [])])))
            continue
        if (isEnvironmentError(entry, pubnetOracles)) {
            notes.push(`node${index} environment: ${describe(entry)}`)
            continue
        }
        problems.push(`node${index} error: ${entry.msg || entry.err?.message || 'unknown'}`)
    }
    return {ok: problems.length === 0, problems, notes}
}

async function observeHealth(ctx, errorLines) {
    const flow = require('./flow')
    const env = require('./env')
    const {raw, hash} = await flow.current(ctx)
    const oracleStates = {}
    for (const contract of Object.values(raw.contracts).filter(c => c.type === 'oracle'))
        oracleStates[contract.contractId] = await ctx.chain.contractState(contract.contractId)
    const runningMembers = await flow.runningMembers(ctx, raw)
    const homes = env.listNodes().filter(n => raw.nodes[n.pubkey])
    return evaluateHealth({
        config: raw,
        hash,
        statistics: await ctx.orch.statistics(),
        runningMembers,
        stoppedMembers: homes.filter(n => !runningMembers.includes(n.pubkey)).map(n => n.pubkey),
        memberIndexes: Object.fromEntries(homes.map(n => [n.pubkey, n.index])),
        oracleStates,
        now: Date.now(),
        errorLines,
        nodeStarts: ctx.nodes.startTimes(),
        clusterStarts: [...(ctx.clusterStarts || []), ...(ctx.nodes.startHistory ? ctx.nodes.startHistory() : [])],
        graceWindows: ctx.graceWindows || []
    })
}

async function checkHealthOnce(ctx, {since, timeout = 8 * 60000}) {
    const flow = require('./flow')
    const env = require('./env')
    let last = {ok: false, problems: ['not checked'], notes: []}
    try {
        await ctx.wait(async () => {
            try {
                last = await observeHealth(ctx, [])
            } catch (err) {
                last = {ok: false, problems: [`health check failed: ${err.message}`], notes: []}
            }
            return last.ok
        }, {timeout, every: 15000, describe: 'a healthy cluster'})
    } catch (err) {
        if (err.message === 'Cancelled')
            throw err
        return last
    }
    //a node that left the cluster keeps logging the failures of being outside it; only members are judged
    const {raw} = await flow.current(ctx)
    const errorLines = []
    for (const node of env.listNodes().filter(n => raw.nodes[n.pubkey]))
        for (const entry of ctx.nodes.readLogLines(node.index, since))
            if (entry.level === 'error' || entry.level === 'fatal')
                errorLines.push({index: node.index, entry})
    return observeHealth(ctx, errorLines)
}

/**
 * Waits until the cluster state is healthy, then judges the error lines logged since `since`. Never throws: a failure
 * to observe the cluster is itself an unhealthy result, and a cancellation is reported as one
 * @param {object} ctx - runner context
 * @param {{since: number, timeout: number}} options - error window start and how long to wait for convergence
 * @returns {Promise<{ok: boolean, problems: string[], notes: string[], cancelled: ?boolean}>}
 */
async function checkHealth(ctx, options) {
    try {
        return await checkHealthOnce(ctx, options)
    } catch (err) {
        if (err.message === 'Cancelled')
            return {ok: false, problems: ['Cancelled'], notes: [], cancelled: true}
        return {ok: false, problems: [`health check failed: ${err.message}`], notes: []}
    }
}

module.exports = {evaluateHealth, checkHealth}
