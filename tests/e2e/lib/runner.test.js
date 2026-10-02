/*eslint-disable no-undef */
const {selectScenarios, runAll} = require('./runner')

const ok = {ok: true, problems: []}
const healthy = () => Promise.resolve(ok)

function scenario(id, overrides = {}) {
    return {
        id,
        title: `scenario ${id}`,
        requires: () => Promise.resolve(null),
        run: () => Promise.resolve(),
        restore: jest.fn(() => Promise.resolve()),
        ...overrides
    }
}

function context() {
    return {observed: [], log: () => {}, diagnostics: () => Promise.resolve({captured: true}), cancelled: false}
}

describe('selectScenarios', () => {
    const all = ['A', 'B', 'C'].map(id => scenario(id))

    test('ids keep catalogue order; --from starts at an id', () => {
        expect(selectScenarios(all, {ids: ['C', 'A']}).map(s => s.id)).toEqual(['A', 'C'])
        expect(selectScenarios(all, {from: 'B'}).map(s => s.id)).toEqual(['B', 'C'])
        expect(selectScenarios(all, {}).map(s => s.id)).toEqual(['A', 'B', 'C'])
    })

    test('an unknown id throws', () => {
        expect(() => selectScenarios(all, {ids: ['Z']})).toThrow('Unknown scenario Z')
        expect(() => selectScenarios(all, {from: 'Z'})).toThrow('Unknown scenario Z')
    })
})

describe('runAll', () => {
    test('a scenario that cannot run is skipped with its reason and not run', async () => {
        const run = jest.fn()
        const skipped = scenario('A', {requires: () => Promise.resolve('needs a spare node'), run})
        const {results} = await runAll(context(), [skipped], {healthCheck: healthy})
        expect(results[0]).toMatchObject({id: 'A', status: 'skipped', reason: 'needs a spare node'})
        expect(run).not.toHaveBeenCalled()
    })

    test('a throwing scenario is failed with diagnostics, restore still runs, the next one runs', async () => {
        const failing = scenario('A', {run: () => Promise.reject(new Error('boom'))})
        const next = scenario('B')
        const {results} = await runAll(context(), [failing, next], {healthCheck: healthy})
        expect(results[0]).toMatchObject({status: 'failed', reason: 'boom', diagnostics: {captured: true}})
        expect(failing.restore).toHaveBeenCalled()
        expect(results[1].status).toBe('passed')
    })

    test('the check before the run judges no error lines logged before it started', async () => {
        const windows = []
        const startedAt = Date.now()
        const healthCheck = (ctx, {since}) => {
            windows.push(since)
            return Promise.resolve(ok)
        }
        await runAll(context(), [scenario('A')], {healthCheck})
        expect(windows[0]).toBeGreaterThanOrEqual(startedAt)
    })

    test('after a failed scenario the health check judges only errors logged after its restore', async () => {
        const windows = []
        let restoredAt = 0
        const failing = scenario('A', {
            run: () => Promise.reject(new Error('boom')),
            restore: () => new Promise(resolve => setTimeout(() => {
                restoredAt = Date.now()
                resolve()
            }, 30))
        })
        const healthCheck = (ctx, {since}) => {
            windows.push(since)
            return Promise.resolve(ok)
        }
        await runAll(context(), [failing], {healthCheck})
        expect(windows[1]).toBeGreaterThanOrEqual(restoredAt)
    })

    test('an unhealthy cluster after a scenario stops the run', async () => {
        let calls = 0
        const healthCheck = () => Promise.resolve(++calls === 2 ? {ok: false, problems: ['oracle X last updated never']} : ok)
        const {results, aborted} = await runAll(context(), [scenario('A'), scenario('B')], {healthCheck})
        expect(aborted).toBe(true)
        expect(results).toHaveLength(1)
        expect(results[0].healthAfter).toEqual(['oracle X last updated never'])
    })

    test('environment notes from the health check after a scenario are kept with its result', async () => {
        const healthCheck = () => Promise.resolve({ok: true, problems: [], notes: ['node0 environment: Pool discovery failed']})
        const {results} = await runAll(context(), [scenario('A')], {healthCheck})
        expect(results[0].environment).toEqual(['node0 environment: Pool discovery failed'])
    })

    test('an unhealthy cluster before the first scenario stops the run without running it', async () => {
        const run = jest.fn()
        const healthCheck = () => Promise.resolve({ok: false, problems: ['p']})
        const {results, aborted} = await runAll(context(), [scenario('A', {run})], {healthCheck})
        expect(aborted).toBe(true)
        expect(run).not.toHaveBeenCalled()
        expect(results).toEqual([])
    })

    test('an interruption stops before the next scenario', async () => {
        let interrupted = false
        const first = scenario('A', {run: () => {
            interrupted = true
            return Promise.resolve()
        }})
        const {results} = await runAll(context(), [first, scenario('B')], {healthCheck: healthy, isInterrupted: () => interrupted})
        expect(results.map(r => r.id)).toEqual(['A'])
    })

    test('a scenario past its timeout is failed and cancelled', async () => {
        const ctx = context()
        const slow = scenario('A', {timeoutMs: 20, run: () => new Promise(resolve => setTimeout(resolve, 200))})
        const {results} = await runAll(ctx, [slow], {healthCheck: healthy})
        expect(results[0]).toMatchObject({status: 'failed', reason: 'A timed out after 0 min'})
        expect(ctx.cancelled).toBe(false)
    })
})

describe('runAll, review fixes', () => {
    test('a health check that throws stops the run with the results so far instead of crashing', async () => {
        let calls = 0
        const healthCheck = () => (++calls === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(ok))
        const {results, aborted} = await runAll(context(), [scenario('A'), scenario('B')], {healthCheck})
        expect(aborted).toBe(true)
        expect(results.map(r => r.id)).toEqual(['A'])
        expect(results[0].healthAfter).toEqual(['health check failed: boom'])
    })

    test('after a timeout the restore waits until the scenario has stopped', async () => {
        const events = []
        const slow = scenario('A', {
            timeoutMs: 20,
            run: async ctx => {
                while (!ctx.cancelled)
                    await new Promise(resolve => setTimeout(resolve, 5))
                await new Promise(resolve => setTimeout(resolve, 30))
                events.push('stopped')
            },
            restore: () => {
                events.push('restore')
                return Promise.resolve()
            }
        })
        await runAll(context(), [slow], {healthCheck: healthy})
        expect(events).toEqual(['stopped', 'restore'])
    })

    test('grace windows a scenario left open are closed after its restore', async () => {
        const ctx = context()
        const leaky = scenario('A', {run: c => {
            c.graceWindows = [{from: 0, to: Infinity}]
            return Promise.reject(new Error('boom'))
        }})
        await runAll(ctx, [leaky], {healthCheck: healthy})
        expect(Number.isFinite(ctx.graceWindows[0].to)).toBe(true)
    })
})
