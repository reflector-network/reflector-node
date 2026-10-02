/*eslint-disable no-undef */
jest.mock('./env', () => {
    const {Keypair} = require('@stellar/stellar-sdk')
    const keys = Array.from({length: 3}, () => Keypair.random())
    return {
        keys,
        knownKeys: () => keys.map((keypair, index) => ({pubkey: keypair.publicKey(), keypair, index})),
        keypairOf: pubkey => keys.find(k => k.publicKey() === pubkey),
        listNodes: () => keys.map((keypair, index) => ({index, pubkey: keypair.publicKey(), keypair})),
        readJson: () => null,
        clusterDir: '/none'
    }
})
jest.mock('./config', () => ({
    hashOf: raw => `hash-${raw.v}`,
    updateTypes: (a, b) => b.types
}))

const env = require('./env')
const flow = require('./flow')

function raw(v, types = [null]) {
    const nodes = {}
    for (const k of env.keys)
        nodes[k.publicKey()] = {pubkey: k.publicKey()}
    return {v, types, nodes, contracts: {}}
}

function context(orchState) {
    const submitted = []
    return {
        submitted,
        members: Object.keys(raw(0).nodes),
        observed: [],
        openProposal: null,
        log: () => {},
        wait: (fn, {timeout}) => require('./wait').until(fn, {timeout: Math.min(timeout, 50), every: 5}),
        orch: {
            getConfig: () => Promise.resolve(orchState()),
            submit: (keypair, next, options = {}) => {
                submitted.push({pubkey: keypair.publicKey(), v: next.v, rejected: !!options.rejected})
                return Promise.resolve({ok: 1})
            },
            statistics: () => Promise.resolve({nodeStatistics: {}})
        },
        nodes: {isRunning: () => Promise.resolve(false)},
        chain: {}
    }
}

const item = (r, extra = {}) => ({config: {config: r, status: 'applied', ...extra}, hash: `hash-${r.v}`})

describe('flow', () => {
    test('applyChange refuses to propose over an open proposal', async () => {
        const ctx = context(() => ({currentConfig: item(raw(1)), pendingConfig: item(raw(2), {status: 'voting'})}))
        await expect(flow.applyChange(ctx, () => raw(3), {expect: null})).rejects.toThrow('A proposal is already open')
        expect(ctx.submitted).toEqual([])
    })

    test('applyChange refuses a change that makes another update than expected', async () => {
        const ctx = context(() => ({currentConfig: item(raw(1)), pendingConfig: null}))
        await expect(flow.applyChange(ctx, () => raw(2, ['wasm']), {expect: 'oracle_cache_size'}))
            .rejects.toThrow('Expected one oracle_cache_size update, the change makes ["wasm"]')
    })

    test('propose submits as the initiator, then votes with every other member', async () => {
        const ctx = context(() => ({currentConfig: item(raw(1)), pendingConfig: null}))
        await flow.propose(ctx, raw(2))
        expect(ctx.submitted.map(s => s.pubkey)).toEqual(env.keys.map(k => k.publicKey()))
        expect(ctx.openProposal.raw.v).toBe(2)
    })

    test('a round that never applies is withdrawn by its initiator', async () => {
        let pending = null
        const ctx = context(() => ({currentConfig: item(raw(1)), pendingConfig: pending}))
        const original = ctx.orch.submit
        ctx.orch.submit = async (keypair, next, options = {}) => {
            await original(keypair, next, options)
            if (!options.rejected)
                pending = item(next, {status: 'pending', timestamp: Date.now()})
        }
        await expect(flow.applyChange(ctx, () => raw(2), {expect: null})).rejects.toThrow('Timed out')
        expect(ctx.submitted.at(-1)).toEqual({pubkey: env.keys[0].publicKey(), v: 2, rejected: true})
        expect(ctx.openProposal).toBeNull()
    })

    test('votes and the withdrawal carry the switch time the orchestrator scheduled', async () => {
        let pending = null
        const ctx = context(() => ({currentConfig: item(raw(1)), pendingConfig: pending}))
        const timestamps = []
        const original = ctx.orch.submit
        ctx.orch.submit = async (keypair, next, options = {}) => {
            timestamps.push(options.timestamp)
            await original(keypair, next, options)
            pending = item(next, {status: 'pending', timestamp: 1_800_000_120_000})
        }
        await flow.propose(ctx, raw(2))
        await flow.withdraw(ctx)
        expect(timestamps).toEqual([0, 1_800_000_120_000, 1_800_000_120_000, 1_800_000_120_000])
    })

    test('withdraw leaves a proposal it did not open alone', async () => {
        const ctx = context(() => ({currentConfig: item(raw(1)), pendingConfig: item(raw(9), {status: 'pending'})}))
        ctx.openProposal = {raw: raw(2), initiator: {keypair: env.keys[0]}}
        expect(await flow.withdraw(ctx)).toBe(false)
        expect(ctx.submitted).toEqual([])
    })

    test('price transactions are read from the contract admin account', async () => {
        const ctx = context(() => null)
        const calls = []
        ctx.chain.recentTransactions = account => {
            calls.push(account)
            return Promise.resolve([
                {successful: true, calls: [{contract: 'C1', fn: 'set_price'}], signers: []},
                {successful: true, calls: [{contract: 'C2', fn: 'set_price'}], signers: []},
                {successful: false, calls: [{contract: 'C1', fn: 'set_price'}], signers: []}
            ])
        }
        const config = {...raw(1), systemAccount: 'SYS', contracts: {C1: {contractId: 'C1', type: 'oracle', admin: 'ADMIN1'}}}
        const txs = await flow.priceTransactions(ctx, config, 'C1', 0)
        expect(calls).toEqual(['ADMIN1'])
        expect(txs).toHaveLength(1)
    })
})

describe('restoreAll', () => {
    test('runs every step even when one fails, then reports the failures', async () => {
        const done = []
        await expect(flow.restoreAll(
            () => Promise.reject(new Error('withdraw failed')),
            () => {
                done.push('start nodes')
                return Promise.resolve()
            }
        )).rejects.toThrow('withdraw failed')
        expect(done).toEqual(['start nodes'])
    })
})
