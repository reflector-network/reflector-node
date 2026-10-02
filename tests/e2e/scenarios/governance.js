const flow = require('../lib/flow')
const {contractOf, mutations, hashOf} = require('../lib/config')
const {gridCeil} = require('../lib/wait')

const minute = 60000

async function members(ctx) {
    const {raw} = await flow.current(ctx)
    return {raw, keys: flow.memberKeys(raw)}
}

async function expectNoNodeHolds(ctx, hash) {
    const stats = (await ctx.orch.statistics()).nodeStatistics || {}
    const holders = Object.entries(stats).filter(([, s]) => s?.pendingConfigHash === hash).map(([pk]) => pk.slice(0, 8))
    if (holders.length)
        throw new Error(`Nodes ${holders.join(', ')} hold a proposal they should not`)
}

function expectStatus(ctx, hash, status) {
    return ctx.wait(async () => {
        const {pending} = await flow.current(ctx)
        if (status === 'rejected')
            return !pending || pending.hash !== hash
        return pending && pending.hash === hash && pending.item.status === status
    }, {timeout: 2 * minute, describe: `proposal ${hash.slice(0, 8)} to be ${status}`})
}

async function requireExchangesOracle(ctx) {
    return contractOf((await flow.current(ctx)).raw, 'oracle', 'exchanges') ? null : 'no exchanges oracle'
}

module.exports = [
    {
        id: 'G1',
        title: 'Minority votes, then a majority',
        requires: () => Promise.resolve(null),
        async run(ctx) {
            const {raw, keys} = await members(ctx)
            const next = mutations.toggleHeartbeat(raw)
            const hash = hashOf(next)
            await flow.propose(ctx, next, {voters: []})
            await expectStatus(ctx, hash, 'voting')
            await ctx.sleep(30000)
            await expectNoNodeHolds(ctx, hash)
            await flow.vote(ctx, keys[1].keypair, next, {})
            const switchTime = await flow.waitPending(ctx, hash)
            await flow.waitApplied(ctx, hash, switchTime)
            await flow.waitNodesOn(ctx, hash)
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'G2',
        title: 'Rejected and withdrawn proposals',
        requires: () => Promise.resolve(null),
        async run(ctx) {
            const {raw, keys} = await members(ctx)
            const next = mutations.toggleHeartbeat(raw)
            const hash = hashOf(next)
            await flow.propose(ctx, next, {voters: [], rejecters: keys.slice(1)})
            await expectStatus(ctx, hash, 'rejected')
            ctx.openProposal = null
            await expectNoNodeHolds(ctx, hash)
            await flow.propose(ctx, next, {voters: []})
            await expectStatus(ctx, hash, 'voting')
            if (!await flow.withdraw(ctx))
                throw new Error('The withdrawal was not sent')
            await expectStatus(ctx, hash, 'rejected')
            await expectNoNodeHolds(ctx, hash)
            if ((await flow.current(ctx)).hash !== hashOf(raw))
                throw new Error('The config changed')
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'G3',
        title: 'Early submission with every vote',
        requires: requireExchangesOracle,
        async run(ctx) {
            const oracle = contractOf((await flow.current(ctx)).raw, 'oracle', 'exchanges')
            const timestamp = gridCeil(Date.now() + 20 * minute)
            const result = await flow.applyChange(ctx, r => mutations.toggleCacheSize(r, oracle.contractId),
                {expect: 'oracle_cache_size', timestamp, allowEarlySubmission: true})
            const landedAt = Math.min(...result.txs.map(tx => tx.time))
            if (!(landedAt < result.switchTime - minute))
                throw new Error(`Landed at ${new Date(landedAt).toISOString()}, not before the switch time ${new Date(result.switchTime).toISOString()}`)
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'G4',
        title: 'Explicit switch time',
        requires: requireExchangesOracle,
        async run(ctx) {
            const {raw, hash: before} = await flow.current(ctx)
            const oracle = contractOf(raw, 'oracle', 'exchanges')
            const next = mutations.togglePeriod(raw, oracle.contractId)
            const {hash} = await flow.propose(ctx, next, {timestamp: gridCeil(Date.now() + 10 * minute)})
            const switchTime = await flow.waitPending(ctx, hash)
            while (Date.now() < switchTime - 10000) {
                if ((await flow.current(ctx)).hash !== before)
                    throw new Error(`Applied before the switch time ${new Date(switchTime).toISOString()}`)
                await ctx.sleep(20000)
            }
            await flow.waitApplied(ctx, hash, switchTime)
            await flow.waitNodesOn(ctx, hash)
            const {item} = await flow.current(ctx)
            for (const txHash of (item.txHash || '').split(',').filter(Boolean)) {
                const tx = await ctx.chain.getTransaction(txHash, flow.knownPubkeys(next))
                ctx.observed.push(tx)
                if (tx.time < switchTime)
                    throw new Error(`The transaction landed at ${new Date(tx.time).toISOString()}, before the switch time`)
            }
        },
        restore: ctx => flow.withdraw(ctx)
    }
]
