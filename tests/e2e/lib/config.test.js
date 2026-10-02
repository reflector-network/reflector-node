/*eslint-disable no-undef */
const crypto = require('crypto')
const {Keypair, StrKey} = require('@stellar/stellar-sdk')
const {mutations, updateTypes, hashOf, contractOf} = require('./config')

const contractId = () => StrKey.encodeContract(crypto.randomBytes(32))
const account = () => Keypair.random().publicKey()
const kps = Array.from({length: 3}, () => Keypair.random())
const token = contractId()
const ids = {oracle: contractId(), beam: contractId(), subscriptions: contractId(), dao: contractId()}
const usd = {type: 2, code: 'USD'}

function fixture() {
    const nodes = {}
    kps.forEach((kp, i) => {
        nodes[kp.publicKey()] = {pubkey: kp.publicKey(), url: `ws://localhost:${30347 + i * 100}`, domain: `node${i}.e2e.local`}
    })
    const oracleBase = {baseAsset: usd, timeframe: 300000, period: 86400000, fee: 10000000, dataSource: 'exchanges', feeConfig: {fee: '100', token}}
    return {
        decimals: 14,
        baseAssets: {exchanges: usd},
        systemAccount: account(),
        priceHeartbeat: 600000,
        minDate: 0,
        network: 'testnet',
        wasmHash: 'a'.repeat(64),
        nodes,
        contracts: {
            [ids.oracle]: {
                ...oracleBase, admin: account(), contractId: ids.oracle, type: 'oracle',
                assets: [{type: 2, code: 'BTC'}, {type: 2, code: 'ETH'}]
            },
            [ids.beam]: {
                ...oracleBase, admin: account(), contractId: ids.beam, type: 'oracle_beam', timeframe: 60000,
                assets: [{type: 2, code: 'BTC', threshold: 1}]
            },
            [ids.subscriptions]: {admin: account(), contractId: ids.subscriptions, type: 'subscriptions', fee: 10000000, baseFee: 1000, token},
            [ids.dao]: {
                admin: account(), contractId: ids.dao, type: 'dao', fee: 10000000, initAmount: '100000000000', developer: account(),
                depositParams: {0: '1000000000', 1: '100000000', 2: '10000000', 3: '1000000000'}, token, startDate: 1789053587271
            }
        }
    }
}

describe('config mutations', () => {
    const raw = fixture()
    const spare = Keypair.random().publicKey()
    const spareNode = {pubkey: spare, url: 'ws://localhost:30647', domain: 'node3.e2e.local'}

    test.each([
        ['addNode', r => mutations.addNode(r, spareNode), ['nodes']],
        ['replaceNode', r => mutations.replaceNode(r, kps[2].publicKey(), spareNode), ['nodes']],
        ['setNodeUrl', r => mutations.setNodeUrl(r, kps[1].publicKey(), 'ws://localhost:30497'), [null]],
        ['addAsset', r => mutations.addAsset(r, ids.oracle, {type: 2, code: 'SOL'}), ['oracle_assets']],
        ['togglePeriod', r => mutations.togglePeriod(r, ids.oracle), ['oracle_history_period']],
        ['toggleFeeConfig', r => mutations.toggleFeeConfig(r, ids.oracle), ['oracle_fee_config']],
        ['toggleCacheSize', r => mutations.toggleCacheSize(r, ids.oracle), ['oracle_cache_size']],
        ['toggleFeeConfig on a beam', r => mutations.toggleFeeConfig(r, ids.beam), ['oracle_fee_config']],
        ['toggleSubscriptionFee', r => mutations.toggleSubscriptionFee(r, ids.subscriptions), ['subscriptions_fee']],
        ['toggleDaoDeposits', r => mutations.toggleDaoDeposits(r, ids.dao), ['dao_deposits']],
        ['setWasm', r => mutations.setWasm(r, 'oracle', 'b'.repeat(64)), ['wasm']],
        ['removeContract', r => mutations.removeContract(r, ids.beam), [null]],
        ['toggleHeartbeat', r => mutations.toggleHeartbeat(r), [null]],
        ['toggleThreshold', r => mutations.toggleThreshold(r, ids.beam), [null]]
    ])('%s makes exactly the expected update', (name, mutate, expected) => {
        const next = mutate(raw)
        expect(updateTypes(raw, next)).toEqual(expected)
        expect(hashOf(next)).not.toBe(hashOf(raw))
    })

    test('no mutation sets beam invocation costs: no contract supports them', () => {
        expect(mutations.toggleInvocationCosts).toBeUndefined()
    })

    test('removeNode from four nodes is a nodes update', () => {
        const four = mutations.addNode(raw, spareNode)
        expect(updateTypes(four, mutations.removeNode(four, spare))).toEqual(['nodes'])
    })

    test('addContract adds a contract with no transaction', () => {
        const extra = {...raw.contracts[ids.oracle], contractId: contractId(), admin: account()}
        expect(updateTypes(raw, mutations.addContract(raw, extra))).toEqual([null])
    })

    test('toggles alternate between two values', () => {
        const once = mutations.togglePeriod(raw, ids.oracle)
        const twice = mutations.togglePeriod(once, ids.oracle)
        expect(twice.contracts[ids.oracle].period).toBe(raw.contracts[ids.oracle].period)
        expect(mutations.toggleCacheSize(mutations.toggleCacheSize(raw, ids.oracle), ids.oracle).contracts[ids.oracle].cacheSize).toBe(10)
    })

    test('setWasm turns a legacy hash into the typed map and keeps the oracle entry', () => {
        const next = mutations.setWasm(raw, 'oracle_beam', 'c'.repeat(64))
        expect(next.wasmHash).toEqual({oracle: {hash: 'a'.repeat(64), type: 'oracle'}, oracle_beam: {hash: 'c'.repeat(64), type: 'oracle_beam'}})
    })

    test('a mutation never modifies its input', () => {
        const before = JSON.stringify(raw)
        mutations.addAsset(raw, ids.oracle, {type: 2, code: 'SOL'})
        mutations.removeNode(raw, kps[0].publicKey())
        expect(JSON.stringify(raw)).toBe(before)
    })

    test('an invalid result throws', () => {
        expect(() => mutations.setWasm(raw, 'oracle', 'not a hash')).toThrow()
    })

    test('contractOf finds a contract by type and data source', () => {
        expect(contractOf(raw, 'oracle', 'exchanges').contractId).toBe(ids.oracle)
        expect(contractOf(raw, 'oracle', 'pubnet')).toBeNull()
    })
})
