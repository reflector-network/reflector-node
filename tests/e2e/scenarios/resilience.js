const env = require('../lib/env')
const flow = require('../lib/flow')
const {contractOf, mutations} = require('../lib/config')
const {gridCeil} = require('../lib/wait')

const minute = 60000

async function threeRunning(ctx) {
    const {raw} = await flow.current(ctx)
    const running = await flow.runningMembers(ctx, raw)
    if (running.length !== 3)
        return `needs three running members, ${running.length} running`
    return contractOf(raw, 'oracle', 'exchanges') ? null : 'no exchanges oracle'
}

function membersByIndex(raw) {
    return env.listNodes().filter(n => raw.nodes[n.pubkey])
}

async function startAll(ctx) {
    const {raw} = await flow.current(ctx)
    for (const node of membersByIndex(raw))
        if (!await ctx.nodes.isRunning(node.index))
            await ctx.nodes.start(node.index)
}

module.exports = [
    {
        id: 'R1',
        title: 'A node down across a switch',
        requires: threeRunning,
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const down = membersByIndex(raw).at(-1)
            const oracle = contractOf(raw, 'oracle', 'exchanges')
            await ctx.nodes.stop(down.index)
            const result = await flow.applyChange(ctx, r => mutations.toggleCacheSize(r, oracle.contractId), {expect: 'oracle_cache_size'})
            for (const tx of result.txs)
                if (tx.signers.includes(down.pubkey) || tx.signers.length < 2)
                    throw new Error(`Unexpected signers ${tx.signers.join(', ')}`)
            await ctx.nodes.start(down.index)
            await flow.waitNodesOn(ctx, result.hash, {pubkeys: [down.pubkey], timeout: 6 * minute})
        },
        restore: ctx => flow.restoreAll(() => flow.withdraw(ctx), () => startAll(ctx))
    },
    {
        id: 'R2',
        title: 'A node restarted while holding a pending update',
        requires: threeRunning,
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const node = membersByIndex(raw).at(-1)
            const oracle = contractOf(raw, 'oracle', 'exchanges')
            const next = mutations.togglePeriod(raw, oracle.contractId)
            const {hash} = await flow.propose(ctx, next, {timestamp: gridCeil(Date.now() + 8 * minute)})
            const switchTime = await flow.waitPending(ctx, hash)
            const holds = async () => (await ctx.orch.statistics()).nodeStatistics?.[node.pubkey]?.pendingConfigHash === hash
            await ctx.wait(holds, {timeout: 2 * minute, describe: 'the node to hold the update'})
            if (!ctx.nodes.pendingFile(node.index))
                throw new Error('No pending file before the restart')
            await ctx.nodes.restart(node.index)
            if (!ctx.nodes.pendingFile(node.index))
                throw new Error('The pending file did not survive the restart')
            await ctx.wait(holds, {timeout: 3 * minute, describe: 'the restarted node to hold the update again'})
            if (Date.now() >= switchTime)
                throw new Error('The restart ran past the switch time; the check proves nothing')
            await flow.waitApplied(ctx, hash, switchTime)
            await flow.waitNodesOn(ctx, hash)
        },
        restore: ctx => flow.restoreAll(() => flow.withdraw(ctx), () => startAll(ctx))
    },
    {
        id: 'R3',
        title: 'Two of three nodes down',
        requires: threeRunning,
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const down = membersByIndex(raw).slice(-2)
            //without a majority the remaining node's submissions time out: expected for the whole outage
            const outage = {from: Date.now(), to: Infinity}
            ctx.graceWindows = [...(ctx.graceWindows || []), outage]
            for (const node of down)
                await ctx.nodes.stop(node.index)
            const oracles = flow.oracles(raw)
            const before = {}
            for (const oracle of oracles)
                before[oracle.contractId] = (await ctx.chain.contractState(oracle.contractId)).lastTimestamp
            await ctx.sleep(Math.max(...oracles.map(o => o.timeframe)) + 2 * minute)
            for (const oracle of oracles) {
                const after = (await ctx.chain.contractState(oracle.contractId)).lastTimestamp
                if (after !== before[oracle.contractId])
                    throw new Error(`Oracle ${oracle.contractId.slice(0, 8)} advanced with one node`)
            }
            for (const node of down)
                await ctx.nodes.start(node.index)
            outage.to = Date.now() + 2 * minute
            for (const oracle of oracles)
                await flow.waitTicks(ctx, oracle, 1)
        },
        restore: startAll
    }
]
