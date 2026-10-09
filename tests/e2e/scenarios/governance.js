const {randomBytes} = require('crypto')
const flow = require('../lib/flow')
const {contractOf, contractsOfType, mutations, hashOf} = require('../lib/config')
const {gridCeil, short} = require('../lib/wait')

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

//nodes held a PENDING update; the statistics that show them dropping it are polled once a minute
function waitNoNodeHolds(ctx, hash) {
    return ctx.wait(async () => {
        const stats = (await ctx.orch.statistics()).nodeStatistics || {}
        return Object.values(stats).every(s => s?.pendingConfigHash !== hash)
    }, {timeout: 3 * minute, every: 10000, describe: `every node to drop proposal ${short(hash)}`})
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

async function requireThreeVoters(ctx) {
    const {raw} = await flow.current(ctx)
    if (!contractOf(raw, 'oracle', 'exchanges'))
        return 'no exchanges oracle'
    const keys = flow.memberKeys(raw)
    return keys.length === 3 && Object.keys(raw.nodes).length === 3 ? null : `needs three members with local keys, ${keys.length} of ${Object.keys(raw.nodes).length}`
}

/**
 * Sleeps until a point in time, cancellable
 * @param {object} ctx - runner context
 * @param {number} time - epoch milliseconds
 * @returns {Promise<void>}
 */
function sleepUntil(ctx, time) {
    return ctx.sleep(Math.max(0, time - Date.now()))
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
    },
    {
        id: 'G5',
        title: 'A proposal whose transaction cannot be built is refused',
        async requires(ctx) {
            const {raw, pending} = await flow.current(ctx)
            if (pending)
                return `a proposal is open: ${short(pending.hash)}`
            return contractsOfType(raw, 'oracle').length ? null : 'no oracle contracts'
        },
        async run(ctx) {
            const {raw, hash: before} = await flow.current(ctx)
            //a code hash nobody uploaded: the contract's upgrade call fails in simulation
            const missing = randomBytes(32).toString('hex')
            if (await ctx.chain.wasmExists(missing))
                throw new Error(`Code ${short(missing)} exists on chain`)
            const next = mutations.setWasm(raw, 'oracle', missing)
            const [initiator] = flow.memberKeys(raw)
            const refusal = await ctx.orch.submit(initiator.keypair, next, {description: ctx.scenarioId}).then(() => null, err => err)
            if (!refusal) {
                ctx.openProposal = {raw: next, initiator}
                throw new Error('A WASM update to code that was never uploaded was accepted')
            }
            //the simulation's own error, not a failure to build the transaction at all
            if (!/The update transaction cannot be built: HostError/.test(refusal.message))
                throw refusal
            ctx.log(`refused: ${refusal.message.slice(0, 200)}`)
            const state = await flow.current(ctx)
            if (state.pending)
                throw new Error(`Proposal ${short(state.pending.hash)} is open after the refusal`)
            if (state.hash !== before)
                throw new Error('The config changed')
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'G6',
        title: 'Votes on a scheduled update change between its rounds, not during one',
        timeoutMs: 15 * minute,
        requires: requireThreeVoters,
        async run(ctx) {
            const {raw, keys} = await members(ctx)
            const oracle = contractOf(raw, 'oracle', 'exchanges')
            const next = mutations.togglePeriod(raw, oracle.contractId)
            const hash = hashOf(next)
            //two votes of three make it PENDING, and every tick is a round of an early submission; the nodes build one only
            //with every vote, so nothing lands
            const options = {voters: [keys[1]], timestamp: gridCeil(Date.now() + 60 * minute), allowEarlySubmission: true}
            await flow.propose(ctx, next, options)
            await flow.waitPending(ctx, hash)
            const voteOptions = {allowEarlySubmission: true, rejected: true}

            const tick = gridCeil(Date.now() + 20000)
            await sleepUntil(ctx, tick - 5000)
            const refusal = await flow.vote(ctx, keys[1].keypair, next, voteOptions).then(() => null, err => err)
            if (!refusal)
                throw new Error('A vote change was accepted 5 s before a round')
            if (!flow.isRoundRefusal(refusal))
                throw refusal
            ctx.log('vote change refused before the round')

            await sleepUntil(ctx, tick + 62000)
            await flow.vote(ctx, keys[1].keypair, next, voteOptions)
            await expectStatus(ctx, hash, 'voting')
            await flow.vote(ctx, keys[2].keypair, next, voteOptions)
            await expectStatus(ctx, hash, 'rejected')
            ctx.openProposal = null
            await waitNoNodeHolds(ctx, hash)
            if ((await flow.current(ctx)).hash !== hashOf(raw))
                throw new Error('The config changed')
        },
        restore: ctx => flow.withdraw(ctx)
    }
]
