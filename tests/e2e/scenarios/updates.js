const {nativeToScVal, xdr} = require('@stellar/stellar-sdk')
const flow = require('../lib/flow')
const {contractOf, mutations} = require('../lib/config')
const {toJson} = require('../lib/chain')

//exchanges assets an update can add, in order; each run adds the first one the contract lacks
const candidateAssets = ['SOL', 'ADA', 'DOGE', 'DOT', 'LINK', 'AVAX', 'LTC', 'BCH', 'TRX', 'UNI', 'ATOM', 'NEAR']

function requireContract(type, dataSource) {
    return async ctx => {
        const {raw} = await flow.current(ctx)
        return contractOf(raw, type, dataSource) ? null : `no ${type} contract${dataSource ? ` on ${dataSource}` : ''}`
    }
}

function assertCalled(result, fn) {
    const calls = result.txs.flatMap(tx => tx.calls.map(c => c.fn))
    if (!calls.includes(fn))
        throw new Error(`The landed transactions call ${JSON.stringify(calls)}, not ${fn}`)
    if (result.txs.some(tx => !tx.successful))
        throw new Error('A landed transaction failed')
}

async function storageValue(ctx, contractId, key) {
    const storage = await ctx.chain.instanceStorage(contractId)
    return storage ? storage[key] : undefined
}

async function expectStorage(ctx, contractId, key, expected) {
    const value = await storageValue(ctx, contractId, key)
    if (value === undefined)
        return ctx.log(`storage key ${key} not found; checked through the transaction only`)
    if (String(value) !== String(expected))
        throw new Error(`Contract ${key} is ${toJson(value)}, expected ${expected}`)
}

function otherAsset(code) {
    return xdr.ScVal.scvVec([nativeToScVal('Other', {type: 'symbol'}), nativeToScVal(code, {type: 'symbol'})])
}

module.exports = [
    {
        id: 'U1',
        title: 'Add an oracle asset',
        requires: requireContract('oracle', 'exchanges'),
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const oracle = contractOf(raw, 'oracle', 'exchanges')
            const codes = new Set(oracle.assets.map(a => a.code))
            const code = candidateAssets.find(c => !codes.has(c))
            if (!code)
                throw new Error('Every candidate asset is already in the contract')
            const result = await flow.applyChange(ctx, r => mutations.addAsset(r, oracle.contractId, {type: 2, code}), {expect: 'oracle_assets'})
            assertCalled(result, 'add_assets')
            const assets = await storageValue(ctx, oracle.contractId, 'assets')
            if (assets !== undefined && !toJson(assets).includes(code))
                throw new Error(`The contract asset list lacks ${code}`)
            await flow.waitTicks(ctx, oracle, 1)
            const price = await ctx.chain.simulate(oracle.contractId, 'lastprice', [otherAsset(code)], raw.systemAccount)
            if (!price)
                throw new Error(`${code} has no price after the next tick`)
        }
    },
    {
        id: 'U2',
        title: 'History retention period',
        requires: requireContract('oracle', 'exchanges'),
        async run(ctx) {
            const oracle = contractOf((await flow.current(ctx)).raw, 'oracle', 'exchanges')
            const result = await flow.applyChange(ctx, r => mutations.togglePeriod(r, oracle.contractId), {expect: 'oracle_history_period'})
            assertCalled(result, 'set_history_retention_period')
            await expectStorage(ctx, oracle.contractId, 'period', result.next.contracts[oracle.contractId].period)
        }
    },
    {
        id: 'U3',
        title: 'Fee config',
        requires: requireContract('oracle', 'exchanges'),
        async run(ctx) {
            const oracle = contractOf((await flow.current(ctx)).raw, 'oracle', 'exchanges')
            const before = toJson(await storageValue(ctx, oracle.contractId, 'retention'))
            const result = await flow.applyChange(ctx, r => mutations.toggleFeeConfig(r, oracle.contractId), {expect: 'oracle_fee_config'})
            assertCalled(result, 'set_fee_config')
            const after = toJson(await storageValue(ctx, oracle.contractId, 'retention'))
            const fee = result.next.contracts[oracle.contractId].feeConfig.fee
            if (after !== undefined && (after === before || !after.includes(`"${fee}"`)))
                throw new Error(`The contract fee config is ${after}, expected fee ${fee}`)
        }
    },
    {
        id: 'U4',
        title: 'Cache size',
        requires: requireContract('oracle', 'exchanges'),
        async run(ctx) {
            const oracle = contractOf((await flow.current(ctx)).raw, 'oracle', 'exchanges')
            const result = await flow.applyChange(ctx, r => mutations.toggleCacheSize(r, oracle.contractId), {expect: 'oracle_cache_size'})
            assertCalled(result, 'set_cache_size')
            await expectStorage(ctx, oracle.contractId, 'cache_size', result.next.contracts[oracle.contractId].cacheSize)
        }
    },
    {
        id: 'U5',
        title: 'Beam fee config',
        requires: requireContract('oracle_beam', 'exchanges'),
        async run(ctx) {
            //a beam's fee config is its daily access rate: the one beam setting besides the shared oracle ones
            const beam = contractOf((await flow.current(ctx)).raw, 'oracle_beam', 'exchanges')
            const before = toJson(await storageValue(ctx, beam.contractId, 'retention'))
            const result = await flow.applyChange(ctx, r => mutations.toggleFeeConfig(r, beam.contractId), {expect: 'oracle_fee_config'})
            assertCalled(result, 'set_fee_config')
            const after = toJson(await storageValue(ctx, beam.contractId, 'retention'))
            const fee = result.next.contracts[beam.contractId].feeConfig.fee
            if (after !== undefined && (after === before || !after.includes(`"${fee}"`)))
                throw new Error(`The beam fee config is ${after}, expected fee ${fee}`)
        }
    },
    {
        id: 'U6',
        title: 'Subscription base fee',
        requires: requireContract('subscriptions'),
        async run(ctx) {
            const contract = contractOf((await flow.current(ctx)).raw, 'subscriptions')
            const result = await flow.applyChange(ctx, r => mutations.toggleSubscriptionFee(r, contract.contractId), {expect: 'subscriptions_fee'})
            assertCalled(result, 'set_fee')
            await expectStorage(ctx, contract.contractId, 'base_fee', result.next.contracts[contract.contractId].baseFee)
        }
    },
    {
        id: 'U7',
        title: 'DAO deposits',
        requires: requireContract('dao'),
        async run(ctx) {
            const contract = contractOf((await flow.current(ctx)).raw, 'dao')
            const result = await flow.applyChange(ctx, r => mutations.toggleDaoDeposits(r, contract.contractId), {expect: 'dao_deposits'})
            assertCalled(result, 'set_deposit')
            await expectStorage(ctx, contract.contractId, '0', result.next.contracts[contract.contractId].depositParams['0'])
        }
    }
].map(s => ({...s, restore: ctx => flow.withdraw(ctx)}))
