const {nativeToScVal, xdr, Address, Keypair} = require('@stellar/stellar-sdk')
const {OracleClient} = require('@reflector/reflector-shared')
const flow = require('../lib/flow')
const {contractOf, mutations} = require('../lib/config')
const {toJson} = require('../lib/chain')
const {settings} = require('../lib/env')

const day = 24 * 60 * 60 * 1000

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

/**
 * Puts back the fee token B1 replaced, after withdrawing a proposal it left open
 * @param {object} ctx - runner context
 * @returns {Promise<void>}
 */
async function restoreFeeToken(ctx) {
    await flow.withdraw(ctx)
    const saved = ctx.beamFeeToken
    if (!saved)
        return
    const beam = (await flow.current(ctx)).raw.contracts[saved.contractId]
    if (beam && beam.feeConfig.token !== saved.token)
        await flow.applyChange(ctx, r => mutations.setFeeToken(r, saved.contractId, saved.token), {expect: 'oracle_fee_config'})
    ctx.beamFeeToken = null
}

/**
 * A beam prices only the feeds someone paid for, and a feed it adds starts unpaid. Its fee token is switched to one this
 * run issues, so a holder of it can pay one day of access to the new asset for itself; the next beam tick must price it,
 * the payer must read the price, a caller that did not pay must be refused, and the fee token is put back
 * @param {object} ctx - runner context
 * @param {object} beam - beam contract config
 * @param {string} code - the asset just added
 * @returns {Promise<void>}
 */
async function trackNewAsset(ctx, beam, code) {
    const {holder: payer, tokenId} = await ctx.chain.createToken('E2EFEE')
    ctx.beamFeeToken = {contractId: beam.contractId, token: beam.feeConfig.token}
    await flow.applyChange(ctx, r => mutations.setFeeToken(r, beam.contractId, tokenId), {expect: 'oracle_fee_config'})
    ctx.log(`the beam's fee token is ${tokenId.slice(0, 8)} for this run`)
    const asset = {type: 2, code}
    const amount = BigInt(beam.feeConfig.fee) //one day of one feed
    const client = new OracleClient(settings.passphrase, settings.sorobanRpc, beam.contractId)
    const self = payer.publicKey()
    const tx = await client.track(await ctx.chain.account(self), {sponsor: self, consumer: self, assets: [asset], amount},
        {fee: 1000000, timebounds: {minTime: 0, maxTime: Math.floor((Date.now() + 60000) / 1000)}})
    const {returnValue} = await ctx.chain.submit(tx, payer)
    const until = Number(returnValue[0]) * 1000
    if (!(until > Date.now() + day - 60 * 60 * 1000 && until < Date.now() + day + 60 * 60 * 1000))
        throw new Error(`Paying one day of ${code} gave access until ${new Date(until).toISOString()}`)
    ctx.log(`paid ${code} on the beam until ${new Date(until).toISOString()}`)

    await flow.waitTicks(ctx, beam, 1)
    const caller = new Address(payer.publicKey()).toScVal()
    const price = await ctx.chain.simulate(beam.contractId, 'lastprice', [caller, otherAsset(code)], payer.publicKey())
    if (!price)
        throw new Error(`The beam has no ${code} price for the account that paid for it`)
    const stranger = new Address(Keypair.random().publicKey()).toScVal()
    const refused = await ctx.chain.simulate(beam.contractId, 'lastprice', [stranger, otherAsset(code)], payer.publicKey()).then(() => null, err => err)
    if (!refused)
        throw new Error(`The beam served ${code} to a caller that did not pay`)
    if (!/#102/.test(refused.message))
        throw refused
    await restoreFeeToken(ctx)
}

/**
 * Adds the first candidate asset the contract lacks; a price oracle quotes it after the next tick, a beam once its feed
 * is paid for
 * @param {object} ctx - runner context
 * @param {string} type - oracle or oracle_beam
 * @returns {Promise<void>}
 */
async function addAsset(ctx, type) {
    const {raw} = await flow.current(ctx)
    const contract = contractOf(raw, type, 'exchanges')
    const codes = new Set(contract.assets.map(a => a.code))
    const code = candidateAssets.find(c => !codes.has(c))
    if (!code)
        throw new Error('Every candidate asset is already in the contract')
    const result = await flow.applyChange(ctx, r => mutations.addAsset(r, contract.contractId, {type: 2, code}), {expect: 'oracle_assets'})
    assertCalled(result, 'add_assets')
    const assets = await storageValue(ctx, contract.contractId, 'assets')
    if (assets !== undefined && !toJson(assets).includes(code))
        throw new Error(`The contract asset list lacks ${code}`)
    if (type === 'oracle_beam')
        return trackNewAsset(ctx, contract, code)
    await flow.waitTicks(ctx, contract, 1)
    const price = await ctx.chain.simulate(contract.contractId, 'lastprice', [otherAsset(code)], raw.systemAccount)
    if (!price)
        throw new Error(`${code} has no price after the next tick`)
}

async function togglePeriod(ctx, type) {
    const contract = contractOf((await flow.current(ctx)).raw, type, 'exchanges')
    const result = await flow.applyChange(ctx, r => mutations.togglePeriod(r, contract.contractId), {expect: 'oracle_history_period'})
    assertCalled(result, 'set_history_retention_period')
    await expectStorage(ctx, contract.contractId, 'period', result.next.contracts[contract.contractId].period)
}

async function toggleCacheSize(ctx, type) {
    const contract = contractOf((await flow.current(ctx)).raw, type, 'exchanges')
    const result = await flow.applyChange(ctx, r => mutations.toggleCacheSize(r, contract.contractId), {expect: 'oracle_cache_size'})
    assertCalled(result, 'set_cache_size')
    await expectStorage(ctx, contract.contractId, 'cache_size', result.next.contracts[contract.contractId].cacheSize)
}

module.exports = [
    {
        id: 'U1',
        title: 'Add an oracle asset',
        requires: requireContract('oracle', 'exchanges'),
        run: ctx => addAsset(ctx, 'oracle')
    },
    {
        id: 'U2',
        title: 'History retention period',
        requires: requireContract('oracle', 'exchanges'),
        run: ctx => togglePeriod(ctx, 'oracle')
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
        run: ctx => toggleCacheSize(ctx, 'oracle')
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
        id: 'B1',
        title: 'Add a beam asset and pay for its feed',
        async requires(ctx) {
            const beam = contractOf((await flow.current(ctx)).raw, 'oracle_beam', 'exchanges')
            if (!beam)
                return 'no oracle_beam contract on exchanges'
            return beam.feeConfig ? null : 'the beam has no fee config'
        },
        run: ctx => addAsset(ctx, 'oracle_beam'),
        restore: restoreFeeToken
    },
    {
        id: 'B2',
        title: 'Beam history retention period',
        requires: requireContract('oracle_beam', 'exchanges'),
        run: ctx => togglePeriod(ctx, 'oracle_beam')
    },
    {
        id: 'B3',
        title: 'Beam cache size',
        requires: requireContract('oracle_beam', 'exchanges'),
        run: ctx => toggleCacheSize(ctx, 'oracle_beam')
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
].map(s => ({...s, restore: s.restore || (ctx => flow.withdraw(ctx))}))
