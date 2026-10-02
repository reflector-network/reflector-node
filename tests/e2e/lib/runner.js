/**
 * @param {object[]} all - catalogue, in order
 * @param {{ids: string[], from: ?string}} selection - explicit ids, or the id to start from
 * @returns {object[]}
 */
function selectScenarios(all, {ids = [], from = null}) {
    const known = new Set(all.map(s => s.id))
    for (const id of [...ids, ...(from ? [from] : [])])
        if (!known.has(id))
            throw new Error(`Unknown scenario ${id}`)
    if (ids.length)
        return all.filter(s => ids.includes(s.id))
    if (from)
        return all.slice(all.findIndex(s => s.id === from))
    return all
}

function withTimeout(promise, ms, id, ctx) {
    let timer = null
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            ctx.cancelled = true
            reject(new Error(`${id} timed out after ${Math.round(ms / 60000)} min`))
        }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

//a cancelled scenario sees ctx.cancelled at its next wait; give it that long to stop before anything else runs
const settleMs = 3 * 60000

function settle(promise) {
    let timer = null
    const limit = new Promise(resolve => {
        timer = setTimeout(resolve, settleMs)
    })
    return Promise.race([promise.catch(() => {}), limit]).finally(() => clearTimeout(timer))
}

async function guarded(healthCheck, ctx, options) {
    try {
        return await healthCheck(ctx, options)
    } catch (err) {
        return {ok: false, problems: [`health check failed: ${err.message}`]}
    }
}

//a scenario that ended early leaves its declared windows open; close them two minutes after its restore
function closeWindows(ctx) {
    for (const window of ctx.graceWindows || [])
        if (window.to === Infinity)
            window.to = Date.now() + 2 * 60000
}

/**
 * Runs scenarios in order with a health check before the first and after each
 * @param {object} ctx - runner context
 * @param {object[]} scenarios - selected scenarios
 * @param {object} hooks - healthCheck(ctx, {since}), isInterrupted(), onResult(result)
 * @returns {Promise<{results: object[], aborted: boolean}>}
 */
async function runAll(ctx, scenarios, {healthCheck, isInterrupted = () => false, onResult = () => {}}) {
    const results = []
    //errors logged before the run belong to whatever ran before it; the first check judges the cluster's state only
    let since = Date.now()
    const before = await guarded(healthCheck, ctx, {since})
    if (!before.ok) {
        ctx.log(`cluster unhealthy before the run: ${before.problems.join('; ')}`)
        return {results, aborted: true}
    }
    since = Date.now()
    for (const scenario of scenarios) {
        if (isInterrupted())
            break
        const started = Date.now()
        const result = {id: scenario.id, title: scenario.title, status: null, reason: null, durationMs: 0, observed: [], diagnostics: null}
        ctx.observed = result.observed
        ctx.scenarioId = scenario.id
        ctx.cancelled = false
        let reason = null
        try {
            reason = await scenario.requires(ctx)
        } catch (err) {
            reason = `requirement check failed: ${err.message}`
        }
        if (reason) {
            Object.assign(result, {status: 'skipped', reason})
            results.push(result)
            onResult(result)
            continue
        }
        ctx.log(`${scenario.id} ${scenario.title}`)
        const running = Promise.resolve().then(() => scenario.run(ctx))
        try {
            await withTimeout(running, scenario.timeoutMs || 45 * 60000, scenario.id, ctx)
            result.status = 'passed'
        } catch (err) {
            result.status = 'failed'
            result.reason = err.message
            result.diagnostics = await ctx.diagnostics().catch(e => ({error: e.message}))
        }
        if (ctx.cancelled)
            await settle(running)
        ctx.cancelled = false
        try {
            if (scenario.restore)
                await scenario.restore(ctx)
        } catch (err) {
            result.restoreError = err.message
        }
        closeWindows(ctx)
        //a failed scenario's own error lines are part of its failure, already recorded; judge what follows the restore
        if (result.status === 'failed')
            since = Date.now()
        const after = await guarded(healthCheck, ctx, {since})
        since = Date.now()
        if (after.notes?.length)
            result.environment = after.notes
        result.durationMs = Date.now() - started
        results.push(result)
        onResult(result)
        if (!after.ok) {
            result.healthAfter = after.problems
            ctx.log(`cluster unhealthy after ${scenario.id}: ${after.problems.join('; ')}`)
            return {results, aborted: true}
        }
    }
    return {results, aborted: false}
}

module.exports = {selectScenarios, runAll}
