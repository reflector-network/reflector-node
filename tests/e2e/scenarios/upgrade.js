const fs = require('fs')
const path = require('path')
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const flow = require('../lib/flow')
const {contractsOfType, mutations} = require('../lib/config')

const wasmDir = path.join(__dirname, '..', 'wasm')
//older first: the released price oracle and its next release, two builds of the next beam
const pins = {
    oracle: ['oracle-v6.0.1.wasm', 'oracle-8fca97d.wasm'],
    oracle_beam: ['beam-09eff51.wasm', 'beam-8fca97d.wasm']
}
//the subscriptions contract goes down to its first release and back to the build the cluster deploys
const subscriptionsV1 = 'subscriptions-v1.0.0.wasm'
const subscriptionsLatest = path.join(__dirname, '..', '..', 'cluster', 'reflector_subscriptions.wasm')

function load(file) {
    const wasm = fs.readFileSync(path.isAbsolute(file) ? file : path.join(wasmDir, file))
    return {file: path.basename(file), wasm, hash: createHash('sha256').update(wasm).digest('hex')}
}

/**
 * The pinned build that is not live; a live build that is neither moves to the newer one
 * @param {string} live - live code hash
 * @param {object[]} builds - the two pinned builds, older first
 * @returns {object}
 */
function targetBuild(live, builds) {
    if (live === builds[1].hash)
        return builds[0]
    return builds[1]
}

/**
 * The builds the subscriptions contract moves through, from the code it runs: down to v1 and back to the latest build,
 * or only back when an interrupted run left it on v1
 * @param {string} live - live code hash
 * @param {object} v1 - first release build
 * @param {object} latest - latest build
 * @returns {object[]}
 */
function roundTrip(live, v1, latest) {
    return live === v1.hash ? [latest] : [v1, latest]
}

/**
 * Moves every contract of a type to a build through a governance WASM update, uploading the build first if needed
 * @param {object} ctx - runner context
 * @param {string} type - contract type
 * @param {object[]} contracts - contracts of that type
 * @param {object} target - build to move to
 * @returns {Promise<void>}
 */
async function moveTo(ctx, type, contracts, target) {
    if (!await ctx.chain.wasmExists(target.hash)) {
        const payer = Keypair.random()
        await ctx.chain.fundAccount(payer.publicKey())
        await ctx.chain.uploadWasm(payer, target.wasm)
    }
    const result = await flow.applyChange(ctx, r => mutations.setWasm(r, type, target.hash), {expect: 'wasm'})
    for (const contract of contracts) {
        const hash = (await ctx.chain.contractState(contract.contractId)).hash
        if (hash !== target.hash)
            throw new Error(`${contract.contractId} runs ${hash}, expected ${target.hash}`)
    }
    ctx.log(`${type}: ${contracts.length} contract(s) on ${target.file} in ${result.txs.length} transaction(s)`)
}

async function upgradeType(ctx, type) {
    const {raw} = await flow.current(ctx)
    const contracts = contractsOfType(raw, type)
    if (!contracts.length)
        return ctx.log(`no ${type} contracts`)
    const live = (await ctx.chain.contractState(contracts[0].contractId)).hash
    const builds = pins[type].map(load)
    const target = targetBuild(live, builds)
    if (!builds.some(b => b.hash === live))
        ctx.log(`${type} runs ${live.slice(0, 8)}, which is neither pinned build; moving it to ${target.file}`)
    await moveTo(ctx, type, contracts, target)
}

async function subscriptionsRoundTrip(ctx) {
    const {raw} = await flow.current(ctx)
    const contracts = contractsOfType(raw, 'subscriptions')
    if (!contracts.length)
        return ctx.log('no subscriptions contracts')
    const live = (await ctx.chain.contractState(contracts[0].contractId)).hash
    for (const target of roundTrip(live, load(subscriptionsV1), load(subscriptionsLatest)))
        await moveTo(ctx, 'subscriptions', contracts, target)
}

module.exports = [{
    id: 'U8',
    title: 'Contract code upgrade',
    timeoutMs: 70 * 60000,
    requires() {
        const missing = [...Object.values(pins).flat(), subscriptionsV1].filter(f => !fs.existsSync(path.join(wasmDir, f)))
        return Promise.resolve(missing.length ? `missing ${missing.join(', ')}; run node tests/e2e/build-wasm.js` : null)
    },
    async run(ctx) {
        await upgradeType(ctx, 'oracle')
        await upgradeType(ctx, 'oracle_beam')
        await subscriptionsRoundTrip(ctx)
        const {raw} = await flow.current(ctx)
        for (const oracle of flow.oracles(raw))
            await flow.waitTicks(ctx, oracle, 1)
    },
    restore: ctx => flow.withdraw(ctx)
}]

module.exports.targetBuild = targetBuild
module.exports.roundTrip = roundTrip
