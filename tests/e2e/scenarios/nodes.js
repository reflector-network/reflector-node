const env = require('../lib/env')
const flow = require('../lib/flow')
const {mutations, hashOf} = require('../lib/config')

function memberCount(raw) {
    return Object.keys(raw.nodes).length
}

function spare(raw) {
    return env.knownKeys().find(k => !raw.nodes[k.pubkey]) || null
}

/**
 * The home of a key, created from a member's app config when it has none
 * @param {object} key - known key
 * @returns {object} node home
 */
function homeOf(key) {
    const existing = env.listNodes().find(n => n.pubkey === key.pubkey)
    if (existing)
        return existing
    return env.createNodeHome(key.keypair, env.listNodes()[0].appConfig)
}

function entryOf(home) {
    return {pubkey: home.pubkey, url: `ws://localhost:${home.appConfig.port}`, domain: `node${home.index}.e2e.local`}
}

/**
 * Starts a node that joins through the config hash anchor, with no stored config of its own
 * @param {object} ctx - runner context
 * @param {object} home - node home
 * @param {string} hash - hash of the config that admits it
 */
async function join(ctx, home, hash) {
    const appConfig = ctx.nodes.readAppConfig(home.index)
    appConfig.clusterConfigHash = hash
    appConfig.orchestratorUrl = env.settings.orchestratorUrl
    ctx.nodes.writeAppConfig(home.index, appConfig)
    ctx.nodes.resetJoinState(home.index)
    await ctx.nodes.start(home.index)
    await flow.waitNodesOn(ctx, hash, {pubkeys: [home.pubkey], timeout: 6 * 60000})
}

/**
 * The member with the highest home index: the one node scenarios move, so node0 stays put
 * @param {object} raw - current config
 * @returns {object} node home
 */
function lastMember(raw) {
    return env.listNodes().filter(n => raw.nodes[n.pubkey]).at(-1)
}

module.exports = [
    {
        id: 'N1',
        title: 'Add a node',
        timeoutMs: 50 * 60000,
        async requires(ctx) {
            const {raw} = await flow.current(ctx)
            if (memberCount(raw) !== 3)
                return `needs three nodes, the cluster has ${memberCount(raw)}`
            return spare(raw) ? null : 'no spare key'
        },
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const home = homeOf(spare(raw))
            const result = await flow.applyChange(ctx, r => mutations.addNode(r, entryOf(home)), {expect: 'nodes'})
            await flow.expectSigner(ctx, result.next, home.pubkey, 1)
            await join(ctx, home, result.hash)
            await flow.waitSignerOnPrice(ctx, result.next, home.pubkey, {since: Date.now()})
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'N2',
        title: 'Remove a node',
        async requires(ctx) {
            const {raw} = await flow.current(ctx)
            return memberCount(raw) === 4 ? null : `needs four nodes, the cluster has ${memberCount(raw)}`
        },
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const removed = lastMember(raw)
            const result = await flow.applyChange(ctx, r => mutations.removeNode(r, removed.pubkey), {expect: 'nodes'})
            ctx.removedIndex = removed.index
            await flow.expectSigner(ctx, result.next, removed.pubkey, 0)
            //the orchestrator closes the removed node's connection as unregistered (1008) and keeps refusing it
            await ctx.wait(() => ctx.nodes.readLogLines(removed.index, result.switchTime)
                .some(e => e.msg === 'Connection closed.' && e.pubkey === 'Orchestrator' && e.code === 1008),
            {timeout: 3 * 60000, every: 10000, describe: 'the orchestrator to refuse the removed node'})
            if (!await ctx.nodes.isRunning(removed.index))
                throw new Error('The removed node stopped on its own')
            const since = Date.now()
            const oracle = flow.oracles(result.next)[0]
            await flow.waitTicks(ctx, oracle, 1)
            const txs = await flow.priceTransactions(ctx, result.next, oracle.contractId, since)
            if (txs.some(tx => tx.signers.includes(removed.pubkey)))
                throw new Error('The removed node signed a price update')
        },
        restore: ctx => flow.restoreAll(() => flow.withdraw(ctx), async () => {
            if (ctx.removedIndex !== undefined)
                await ctx.nodes.remove(ctx.removedIndex)
            ctx.removedIndex = undefined
        })
    },
    {
        id: 'N3',
        title: 'Rotate a node',
        timeoutMs: 50 * 60000,
        async requires(ctx) {
            const {raw} = await flow.current(ctx)
            if (memberCount(raw) !== 3)
                return `needs three nodes, the cluster has ${memberCount(raw)}`
            return spare(raw) ? null : 'no spare key'
        },
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const removed = lastMember(raw)
            const added = homeOf(spare(raw))
            const result = await flow.applyChange(ctx, r => mutations.replaceNode(r, removed.pubkey, entryOf(added)), {expect: 'nodes'})
            const system = result.txs.flatMap(tx => tx.setOptions).filter(o => o.source === raw.systemAccount && o.signer)
            const weights = Object.fromEntries(system.map(o => [o.signer.pubkey, o.signer.weight]))
            if (result.txs.length !== 1 || weights[removed.pubkey] !== 0 || weights[added.pubkey] !== 1)
                throw new Error(`Expected one transaction removing and adding signers, got ${result.txs.length}: ${JSON.stringify(weights)}`)
            await flow.expectSigner(ctx, result.next, added.pubkey, 1)
            await flow.expectSigner(ctx, result.next, removed.pubkey, 0)
            await join(ctx, added, result.hash)
            await ctx.nodes.remove(removed.index)
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'N4',
        title: 'Change a node URL',
        async requires(ctx) {
            const {raw} = await flow.current(ctx)
            return memberCount(raw) >= 3 ? null : 'needs three nodes'
        },
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const moved = lastMember(raw)
            const appConfig = ctx.nodes.readAppConfig(moved.index)
            const base = env.defaultPort(moved.index)
            appConfig.port = appConfig.port === base ? base + 50 : base
            ctx.movedIndex = moved.index
            //until the switch its peers dial the old port: the moved node misses their trades data, and the two others may
            //price a tick differently and skip it - every node's submission errors are expected; a second missed tick
            //still fails the oracle freshness check
            ctx.graceWindows = [...(ctx.graceWindows || []), {from: Date.now(), to: Infinity,
                patterns: [/^Trades data not found for contract/]}]
            ctx.nodes.writeAppConfig(moved.index, appConfig)
            await ctx.nodes.restart(moved.index)
            const url = `ws://localhost:${appConfig.port}`
            const result = await flow.applyChange(ctx, r => mutations.setNodeUrl(r, moved.pubkey, url), {expect: null})
            await flow.waitSignerOnPrice(ctx, result.next, moved.pubkey, {since: Date.now()})
        },
        restore: ctx => flow.restoreAll(() => flow.withdraw(ctx), async () => {
            //a node left listening on a port its config entry does not name is put back on the configured one
            const index = ctx.movedIndex
            ctx.movedIndex = undefined
            if (index === undefined)
                return
            const {raw} = await flow.current(ctx)
            const home = env.listNodes().find(n => n.index === index)
            const configured = Number(new URL(raw.nodes[home.pubkey].url).port)
            const appConfig = ctx.nodes.readAppConfig(index)
            if (appConfig.port !== configured) {
                appConfig.port = configured
                ctx.nodes.writeAppConfig(index, appConfig)
                await ctx.nodes.restart(index)
            }
        })
    },
    {
        id: 'N5',
        title: 'Refuse leaving less than a majority',
        async requires(ctx) {
            const {raw} = await flow.current(ctx)
            return memberCount(raw) === 3 ? null : 'needs three nodes'
        },
        async run(ctx) {
            const {raw, hash} = await flow.current(ctx)
            const [keep, ...drop] = Object.keys(raw.nodes)
            const next = drop.reduce((r, pubkey) => mutations.removeNode(r, pubkey), raw)
            const initiator = flow.memberKeys(raw).find(k => k.pubkey === keep)
            try {
                await ctx.orch.submit(initiator.keypair, next)
            } catch (err) {
                if (err.status >= 400 && err.status < 500) {
                    const after = await flow.current(ctx)
                    if (after.hash !== hash || after.pending)
                        throw new Error('The config changed after the refusal')
                    return ctx.log(`refused: ${err.message}`)
                }
                throw err
            }
            ctx.openProposal = {raw: next, initiator}
            throw new Error(`The orchestrator accepted a proposal leaving ${hashOf(next).slice(0, 8)} with one node`)
        },
        restore: ctx => flow.withdraw(ctx)
    }
]
