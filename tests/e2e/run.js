#!/usr/bin/env node
const {execFileSync} = require('child_process')
const path = require('path')
const env = require('./lib/env')
const chain = require('./lib/chain')
const nodes = require('./lib/nodes')
const flow = require('./lib/flow')
const {NonceStore, OrchestratorClient} = require('./lib/orchestrator')
const orchestratorProcess = require('./lib/orchestrator-process')
const {until, cancellableSleep} = require('./lib/wait')
const {checkHealth} = require('./lib/health')
const {selectScenarios, runAll} = require('./lib/runner')
const {writeReport} = require('./lib/report')
const catalogue = require('./scenarios')

function parseArgs(argv) {
    const args = {command: 'run', ids: [], from: null, reset: false, withdrawOpen: false, restoreEdited: false}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === 'bootstrap')
            args.command = 'bootstrap'
        else if (arg === 'stop-orchestrator')
            args.command = 'stop-orchestrator'
        else if (arg === '--list')
            args.command = 'list'
        else if (arg === '--reset')
            args.reset = true
        else if (arg === '--withdraw-open')
            args.withdrawOpen = true
        else if (arg === '--restore-edited')
            args.restoreEdited = true
        else if (arg === '--from')
            args.from = argv[++i] || ''
        else
            args.ids.push(arg)
    }
    if (args.from === '')
        throw new Error('--from needs a scenario id')
    return args
}

async function collectDiagnostics(ctx) {
    const out = {}
    try {
        const config = await ctx.orch.getConfig(flow.signerKey(ctx))
        for (const entry of [config.currentConfig, config.pendingConfig])
            if (entry)
                delete entry.config.config.clusterSecret
        out.config = config
    } catch (err) {
        out.config = err.message
    }
    out.statistics = await ctx.orch.statistics().then(s => s.nodeStatistics).catch(err => err.message)
    out.nodes = []
    for (const node of env.listNodes())
        out.nodes.push({
            index: node.index,
            pubkey: node.pubkey,
            running: await nodes.isRunning(node.index),
            pending: nodes.pendingFile(node.index) ? 'present' : null,
            log: nodes.readLogLines(node.index, Date.now() - 30 * 60000).slice(-200).map(e => `${e.time} ${e.level} ${e.msg}`)
        })
    return out
}

function createContext() {
    const ctx = {
        orch: new OrchestratorClient({baseUrl: env.settings.orchestratorUrl, nonces: new NonceStore(env.stateFile('nonces.json'))}),
        chain,
        nodes,
        observed: [],
        openProposal: null,
        cancelled: false,
        scenarioId: null,
        members: null,
        log: message => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)
    }
    ctx.wait = (fn, options) => until(fn, {...options, log: ctx.log, isCancelled: () => ctx.cancelled})
    ctx.sleep = ms => cancellableSleep(ms, () => ctx.cancelled)
    ctx.diagnostics = () => collectDiagnostics(ctx)
    return ctx
}

function imageCheck() {
    let created
    try {
        created = Date.parse(execFileSync('docker', ['image', 'inspect', env.settings.image, '-f', '{{.Created}}']).toString().trim())
    } catch (err) {
        throw new Error(`Image ${env.settings.image} not found: ${err.message}`)
    }
    const commit = Date.parse(execFileSync('git', ['log', '-1', '--format=%cI'], {cwd: path.resolve(__dirname, '..', '..')}).toString().trim())
    if (created < commit)
        console.warn(`WARNING: image ${env.settings.image} is older than the last commit; rebuild with npm run build && npm run build-docker-image`)
    return `${env.settings.image} built ${new Date(created).toISOString()}`
}

async function withdrawOpen(ctx, pending) {
    const keys = flow.memberKeys(pending.raw)
    ctx.openProposal = {raw: pending.raw, initiator: keys.find(k => k.pubkey === pending.item.initiator) || keys[0]}
    await flow.withdraw(ctx)
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (args.command === 'list') {
        for (const s of catalogue)
            console.log(`${s.id.padEnd(4)} ${s.title}`)
        return 0
    }
    if (args.command === 'stop-orchestrator') {
        await orchestratorProcess.stop()
        return 0
    }
    const ctx = createContext()
    const image = imageCheck()
    if (args.command === 'bootstrap') {
        await require('./lib/bootstrap').bootstrap(ctx, {reset: args.reset})
        return 0
    }
    const selected = selectScenarios(catalogue, args)
    await orchestratorProcess.ensureRunning(ctx.log)
    const edited = nodes.editedHomes()
    if (edited.length) {
        if (!args.restoreEdited) {
            console.error(`node${edited.join(', node')} still carry a scenario's app config edit. Rerun with --restore-edited to put the originals back.`)
            return 2
        }
        for (const index of edited) {
            nodes.restoreAppConfig(index)
            await nodes.restart(index)
        }
    }
    const {pending} = await flow.current(ctx)
    if (pending) {
        if (!args.withdrawOpen) {
            console.error(`A proposal is open (${pending.hash.slice(0, 8)}, ${pending.item.status}). Wait for it, or rerun with --withdraw-open.`)
            return 2
        }
        await withdrawOpen(ctx, pending)
    }
    let interrupted = false
    process.on('SIGINT', () => {
        if (interrupted)
            process.exit(130)
        interrupted = true
        ctx.cancelled = true
        console.log('Interrupted: restoring the current scenario, Ctrl-C again to quit at once')
    })
    const startedAt = Date.now()
    //results are collected as they come, so whatever ends the run, the report holds every finished scenario
    const results = []
    let aborted = true
    try {
        ({aborted} = await runAll(ctx, selected, {
            healthCheck: checkHealth,
            isInterrupted: () => interrupted,
            onResult: r => {
                results.push(r)
                ctx.log(`${r.id} ${r.status.toUpperCase()}${r.reason ? ': ' + r.reason : ''}`)
            }
        }))
    } finally {
        const files = writeReport(results, {startedAt, finishedAt: Date.now(), aborted: aborted || interrupted, image})
        console.log(`Report: ${files.md}`)
    }
    return results.some(r => r.status === 'failed') || aborted ? 1 : 0
}

main().then(code => process.exit(code), err => {
    console.error(err)
    process.exit(1)
})
