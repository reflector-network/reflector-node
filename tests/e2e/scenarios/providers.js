const env = require('../lib/env')
const flow = require('../lib/flow')
const {contractOf} = require('../lib/config')

const exchanges = ['binance', 'bybit', 'coinbase', 'kraken', 'okx']

function members(raw) {
    return env.listNodes().filter(n => raw.nodes[n.pubkey])
}

async function setProviders(ctx, node, source, providers) {
    ctx.nodes.editAppConfig(node.index, c => {
        c.dataSources[source].providers = providers
    })
    //marked before the restart, so a failed restart still gets the original config back
    ctx.edited = [...new Set([...(ctx.edited || []), node.index])]
    await ctx.nodes.restart(node.index)
}

async function restoreProviders(ctx) {
    for (const index of ctx.edited || [])
        if (ctx.nodes.restoreAppConfig(index))
            await ctx.nodes.restart(index)
    ctx.edited = []
    for (const window of ctx.graceWindows || [])
        if (window.to === Infinity)
            window.to = Date.now() + 2 * 60000
}

function requireSource(dataSource) {
    return async ctx => {
        const {raw} = await flow.current(ctx)
        if (!contractOf(raw, 'oracle', dataSource))
            return `no ${dataSource} oracle`
        const running = await flow.runningMembers(ctx, raw)
        if (running.length !== 3)
            return `needs three running members, ${running.length} running`
        return members(raw).every(n => n.appConfig.dataSources?.[dataSource]) ? null : `a member has no ${dataSource} data source`
    }
}

/**
 * One node on different providers: the oracle keeps landing, and that node's signature is missing at least once
 * @param {object} ctx - runner context
 * @param {string} dataSource - data source to change
 * @param {any} providers - the changed node's providers
 */
async function minorityChange(ctx, dataSource, providers) {
    const {raw} = await flow.current(ctx)
    const node = members(raw).at(-1)
    const oracle = contractOf(raw, 'oracle', dataSource)
    //the changed node builds its own price update, which never gathers a majority: its submissions fail by design
    ctx.graceWindows = [...(ctx.graceWindows || []), {from: Date.now(), to: Infinity, index: node.index}]
    await setProviders(ctx, node, dataSource, providers)
    const since = Date.now()
    await flow.waitTicks(ctx, oracle, 3)
    const txs = await flow.priceTransactions(ctx, raw, oracle.contractId, since)
    if (txs.length < 3)
        throw new Error(`Expected three price updates, found ${txs.length}`)
    if (txs.every(tx => tx.signers.includes(node.pubkey)))
        throw new Error('The changed node signed every update; its data did not diverge')
}

module.exports = [
    {
        id: 'P1',
        title: 'One node drops an exchanges provider',
        timeoutMs: 40 * 60000,
        requires: requireSource('exchanges'),
        run: ctx => minorityChange(ctx, 'exchanges', exchanges.filter(p => p !== 'okx')),
        restore: restoreProviders
    },
    {
        id: 'P2',
        title: 'Every node makes the same provider change',
        timeoutMs: 40 * 60000,
        requires: requireSource('exchanges'),
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const oracle = contractOf(raw, 'oracle', 'exchanges')
            for (const node of members(raw))
                await setProviders(ctx, node, 'exchanges', exchanges.filter(p => p !== 'kraken'))
            const since = Date.now()
            await flow.waitTicks(ctx, oracle, 3)
            const txs = await flow.priceTransactions(ctx, raw, oracle.contractId, since)
            const missing = members(raw).filter(n => !txs.some(tx => tx.signers.includes(n.pubkey)))
            if (missing.length)
                throw new Error(`node${missing.map(n => n.index).join(', node')} signed none of ${txs.length} updates`)
        },
        restore: restoreProviders
    },
    {
        id: 'P3',
        title: 'No two nodes share a provider',
        timeoutMs: 40 * 60000,
        requires: requireSource('exchanges'),
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const oracle = contractOf(raw, 'oracle', 'exchanges')
            const lists = [['binance', 'bybit'], ['coinbase', 'kraken'], ['okx']]
            const nodes = members(raw)
            //no node gathers a majority for the exchanges oracle, so every node reports its trades data missing
            ctx.graceWindows = [...(ctx.graceWindows || []), {from: Date.now(), to: Infinity, patterns: [/^Trades data not found for contract/]}]
            for (let i = 0; i < nodes.length; i++)
                await setProviders(ctx, nodes[i], 'exchanges', lists[i])
            await ctx.sleep(60000)
            const before = (await ctx.chain.contractState(oracle.contractId)).lastTimestamp
            const others = flow.oracles(raw).filter(o => o.contractId !== oracle.contractId)
            const othersBefore = await Promise.all(others.map(o => ctx.chain.contractState(o.contractId)))
            await ctx.sleep(2 * oracle.timeframe + 60000)
            const after = (await ctx.chain.contractState(oracle.contractId)).lastTimestamp
            if (after !== before)
                throw new Error(`The exchanges oracle advanced (${before} -> ${after}) with no shared provider`)
            for (let i = 0; i < others.length; i++)
                if ((await ctx.chain.contractState(others[i].contractId)).lastTimestamp === othersBefore[i].lastTimestamp)
                    throw new Error(`Oracle ${others[i].contractId.slice(0, 8)} stopped too`)
            await restoreProviders(ctx)
            await flow.waitTicks(ctx, oracle, 1)
        },
        restore: restoreProviders
    },
    {
        id: 'P4',
        title: 'One node limits pubnet to Aqua',
        timeoutMs: 40 * 60000,
        requires: requireSource('pubnet'),
        run: ctx => minorityChange(ctx, 'pubnet', {AQUA: {}}),
        restore: restoreProviders
    }
]
