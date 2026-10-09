const path = require('path')
const fs = require('fs')
const env = require('./env')
const configs = require('./config')
const {checkHealth} = require('./health')
const orchestrator = require('./orchestrator-process')

const minute = 60000

/**
 * Moves the runner's orchestrator to a database no run has used, so it starts empty
 * @param {object} ctx - runner context
 * @param {string} firstPubkey - the key that posts the first config
 */
async function resetOrchestrator(ctx, firstPubkey) {
    await orchestrator.stop()
    orchestrator.prepare({dbName: orchestrator.newDatabaseName(), defaultNodes: [firstPubkey]})
    await orchestrator.start(ctx.log)
}

/**
 * Starts the runner's orchestrator if nothing answers, writing its config on the first start
 * @param {object} ctx - runner context
 * @param {string} firstPubkey - the key that posts the first config
 */
async function ensureOrchestrator(ctx, firstPubkey) {
    if (await orchestrator.isUp())
        return
    if (!orchestrator.state().dbName)
        orchestrator.prepare({dbName: orchestrator.newDatabaseName(), defaultNodes: [firstPubkey]})
    await orchestrator.start(ctx.log)
}

/**
 * Points the existing cluster at localhost and the orchestrator, posts its config as the first one and starts the
 * containers on the host network
 * @param {object} ctx - runner context
 * @param {{reset: boolean}} options - drop the orchestrator database first
 */
async function bootstrap(ctx, {reset}) {
    const clusterFile = path.join(env.clusterDir, '.config.json')
    const raw = env.readJson(clusterFile)
    if (!raw)
        throw new Error(`No cluster config at ${clusterFile}; run npm run run-docker-cluster once first`)
    const members = env.listNodes().filter(n => raw.nodes[n.pubkey])
    if (members.length < 3)
        throw new Error(`Expected at least three member homes in ${env.clusterDir}, found ${members.length}`)
    const first = members[0]
    if (reset)
        await resetOrchestrator(ctx, first.pubkey)
    else
        await ensureOrchestrator(ctx, first.pubkey)

    for (const node of members) {
        const appConfig = ctx.nodes.readAppConfig(node.index)
        appConfig.port = env.defaultPort(node.index)
        appConfig.orchestratorUrl = env.settings.orchestratorUrl
        if (appConfig.dataSources?.pubnet)
            appConfig.dataSources.pubnet.sorobanRpc = env.settings.pubnetRpc
        delete appConfig.clusterConfigHash
        ctx.nodes.writeAppConfig(node.index, appConfig)
        raw.nodes[node.pubkey].url = `ws://localhost:${appConfig.port}`
    }
    env.writeJson(clusterFile, raw)
    for (const node of members)
        fs.copyFileSync(clusterFile, path.join(node.home, '.config.json'))
    const hash = configs.hashOf(raw)

    const existing = await ctx.orch.getConfig(first.keypair)
    if (!existing.currentConfig) {
        ctx.log(`posting the first config ${hash.slice(0, 8)} as ${first.pubkey.slice(0, 8)}`)
        await ctx.orch.submit(first.keypair, raw)
        for (const node of members.slice(1))
            await ctx.orch.submit(node.keypair, raw)
    } else if (existing.currentConfig.hash !== hash) {
        throw new Error(`The orchestrator holds config ${existing.currentConfig.hash.slice(0, 8)}, the cluster folder ${hash.slice(0, 8)}; run bootstrap --reset`)
    }

    for (const node of members) {
        ctx.log(`starting node${node.index} on port ${env.defaultPort(node.index)}`)
        await ctx.nodes.start(node.index)
    }
    const health = await checkHealth(ctx, {since: Date.now(), timeout: 15 * minute})
    if (!health.ok)
        throw new Error(`The cluster is not healthy after bootstrap: ${health.problems.join('; ')}`)
    ctx.log('bootstrap complete: the cluster is healthy')
}

module.exports = {bootstrap}
