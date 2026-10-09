const path = require('path')
const {getMajority} = require('@reflector/reflector-shared')
const env = require('./env')
const configs = require('./config')
const {short} = require('./wait')

const minute = 60000

/**
 * A key of a current member the runner holds the secret of; the orchestrator signs only for registered keys
 * @param {object} ctx - runner context
 * @returns {Keypair}
 */
function signerKey(ctx) {
    const members = ctx.members || Object.keys(env.readJson(path.join(env.clusterDir, '.config.json'))?.nodes || {})
    const key = env.knownKeys().find(k => members.includes(k.pubkey))
    if (!key)
        throw new Error('No local secret of a current cluster member')
    return key.keypair
}

function unpack(entry) {
    return entry ? {raw: entry.config.config, hash: entry.hash, item: entry.config} : null
}

/**
 * @param {object} ctx - runner context
 * @returns {Promise<{raw: object, hash: string, item: object, pending: ?object}>}
 */
async function current(ctx) {
    const res = await ctx.orch.getConfig(signerKey(ctx))
    if (!res?.currentConfig)
        throw new Error('The orchestrator holds no config; run bootstrap')
    const result = {...unpack(res.currentConfig), pending: unpack(res.pendingConfig)}
    ctx.members = Object.keys(result.raw.nodes)
    return result
}

function memberKeys(raw) {
    const known = env.knownKeys()
    return Object.keys(raw.nodes)
        .map(pubkey => known.find(k => k.pubkey === pubkey))
        .filter(Boolean)
        .map(k => ({pubkey: k.pubkey, keypair: k.keypair}))
}

function knownPubkeys(raw) {
    return [...new Set([...Object.keys(raw.nodes), ...env.knownKeys().map(k => k.pubkey)])]
}

async function runningMembers(ctx, raw) {
    raw = raw || (await current(ctx)).raw
    const homes = env.listNodes()
    const running = []
    for (const pubkey of Object.keys(raw.nodes)) {
        const node = homes.find(h => h.pubkey === pubkey)
        if (node && await ctx.nodes.isRunning(node.index))
            running.push(pubkey)
    }
    return running
}

/**
 * Votes on a proposal. The orchestrator matches a vote by config and timestamp, and once a proposal reaches a majority
 * its timestamp becomes the scheduled switch time, so every vote after the first carries the stored one
 * @param {object} ctx - runner context
 * @param {object} keypair - voting key
 * @param {object} nextRaw - proposed config
 * @param {object} options - submit() options; timestamp is replaced by the open proposal's
 * @returns {Promise<object>}
 */
async function vote(ctx, keypair, nextRaw, options) {
    const {pending} = await current(ctx)
    const timestamp = pending && pending.hash === configs.hashOf(nextRaw) ? pending.item.timestamp : options.timestamp
    return ctx.orch.submit(keypair, nextRaw, {...options, timestamp})
}

/**
 * Proposes a config as the initiator, then votes with the given members
 * @param {object} ctx - runner context
 * @param {object} nextRaw - proposed config
 * @param {object} [options] - initiator, voters (default: every other member), rejecters, timestamp, allowEarlySubmission
 * @returns {Promise<{hash: string, initiator: object}>}
 */
async function propose(ctx, nextRaw, {initiator, voters, rejecters = [], timestamp = 0, allowEarlySubmission = false} = {}) {
    const {raw} = await current(ctx)
    const keys = memberKeys(raw)
    const init = initiator || keys[0]
    const options = {timestamp, allowEarlySubmission, description: ctx.scenarioId || 'e2e'}
    await ctx.orch.submit(init.keypair, nextRaw, options)
    ctx.openProposal = {raw: nextRaw, initiator: init}
    for (const key of voters || keys.filter(k => k.pubkey !== init.pubkey))
        await vote(ctx, key.keypair, nextRaw, options)
    for (const key of rejecters)
        await vote(ctx, key.keypair, nextRaw, {...options, rejected: true})
    return {hash: configs.hashOf(nextRaw), initiator: init}
}

/**
 * Whether the orchestrator refused a vote change because a round of the PENDING update is in flight; the same vote is
 * accepted once the round is over
 * @param {Error} err - submit error
 * @returns {boolean}
 */
function isRoundRefusal(err) {
    return /An update round is in progress/.test(err?.message || '')
}

const roundRetryDelay = 20000
//a round and the lead time before it span 76 s of every 2-minute tick
const maxRoundRetries = 6

/**
 * Withdraws the proposal this run opened, if it is still open. A withdrawal refused while a round is in flight is sent
 * again after it
 * @param {object} ctx - runner context
 * @returns {Promise<boolean>} whether a withdrawal was sent
 */
async function withdraw(ctx) {
    const open = ctx.openProposal
    ctx.openProposal = null
    if (!open)
        return false
    for (let attempt = 0; ; attempt++) {
        const {pending} = await current(ctx)
        if (!pending || pending.hash !== configs.hashOf(open.raw))
            return false
        try {
            await ctx.orch.submit(open.initiator.keypair, open.raw, {rejected: true, timestamp: pending.item.timestamp})
            ctx.log(`withdrew proposal ${short(pending.hash)}`)
            return true
        } catch (err) {
            if (!isRoundRefusal(err) || attempt >= maxRoundRetries)
                throw err
            ctx.log(`withdrawal of ${short(pending.hash)} refused during a round; retrying`)
            await ctx.sleep(roundRetryDelay)
        }
    }
}

function waitPending(ctx, hash) {
    return ctx.wait(async () => {
        const {pending} = await current(ctx)
        return pending && pending.hash === hash && pending.item.status === 'pending' ? pending.item.timestamp : null
    }, {timeout: 3 * minute, describe: `proposal ${short(hash)} to become pending`})
}

async function waitApplied(ctx, hash, switchTime) {
    const timeout = Math.max(0, switchTime - Date.now()) + 6 * minute
    const item = await ctx.wait(async () => {
        const state = await current(ctx)
        return state.hash === hash ? state.item : null
    }, {timeout, every: 10000, describe: `config ${short(hash)} to be applied`})
    ctx.openProposal = null
    return item
}

async function waitNodesOn(ctx, hash, {pubkeys, timeout = 4 * minute} = {}) {
    const targets = pubkeys || await runningMembers(ctx)
    return ctx.wait(async () => {
        const stats = (await ctx.orch.statistics()).nodeStatistics || {}
        return targets.every(pubkey => stats[pubkey]?.currentConfigHash === hash && !stats[pubkey].pendingConfigHash)
    }, {timeout, describe: `${targets.length} node(s) to switch to ${short(hash)}`})
}

/**
 * Proposes a change, has every member vote, waits for the switch and for the running members to follow
 * @param {object} ctx - runner context
 * @param {function(object): object} mutate - builds the next config from the current one
 * @param {object} [options] - expect (the single update type the change must make, null for none) and propose() options
 * @returns {Promise<object>} previous, next, hash, item, switchTime, txs
 */
async function applyChange(ctx, mutate, {expect, ...options} = {}) {
    const state = await current(ctx)
    if (state.pending)
        throw new Error(`A proposal is already open: ${short(state.pending.hash)} (${state.pending.item.status})`)
    const next = mutate(state.raw)
    const types = configs.updateTypes(state.raw, next)
    if (expect !== undefined && !(types.length === 1 && types[0] === expect))
        throw new Error(`Expected one ${expect} update, the change makes ${JSON.stringify(types)}`)
    const {hash} = await propose(ctx, next, options)
    ctx.log(`proposed ${types.join(',')} as ${short(hash)}`)
    let switchTime
    let item
    try {
        switchTime = await waitPending(ctx, hash)
        ctx.log(`pending; switch at ${new Date(switchTime).toISOString()}`)
        item = await waitApplied(ctx, hash, switchTime)
    } catch (err) {
        await withdraw(ctx).catch(e => ctx.log(`withdrawal failed: ${e.message}`))
        throw err
    }
    await waitNodesOn(ctx, hash)
    const txs = []
    for (const txHash of (item.txHash || '').split(',').filter(Boolean)) {
        const tx = await ctx.chain.getTransaction(txHash, knownPubkeys(next))
        ctx.observed.push(tx)
        txs.push(tx)
    }
    return {previous: state.raw, next, hash, item, switchTime, txs}
}

function oracles(raw, dataSource) {
    return Object.values(raw.contracts).filter(c => c.type === 'oracle' && (!dataSource || c.dataSource === dataSource))
}

async function waitTicks(ctx, contract, count) {
    const seen = []
    let last = (await ctx.chain.contractState(contract.contractId)).lastTimestamp
    for (let i = 0; i < count; i++) {
        const previous = last
        last = await ctx.wait(async () => {
            const ts = (await ctx.chain.contractState(contract.contractId)).lastTimestamp
            return ts > previous ? ts : null
        }, {timeout: contract.timeframe + 3 * minute, every: 15000, describe: `oracle ${short(contract.contractId)} tick ${i + 1} of ${count}`})
        seen.push(last)
    }
    return seen
}

function isPriceUpdate(tx, contractId) {
    return tx.successful && tx.calls.some(c => c.fn === 'set_price' && (!contractId || c.contract === contractId))
}

/**
 * Successful price updates of one contract since a time; a contract's price updates are sourced by its admin account
 * @param {object} ctx - runner context
 * @param {object} raw - config holding the contract
 * @param {string} contractId - oracle
 * @param {number} since - earliest ledger close time, ms
 * @returns {Promise<object[]>}
 */
async function priceTransactions(ctx, raw, contractId, since) {
    const admin = raw.contracts[contractId].admin
    const txs = await ctx.chain.recentTransactions(admin, {since, knownPubkeys: knownPubkeys(raw)})
    const prices = txs.filter(tx => isPriceUpdate(tx, contractId))
    ctx.observed.push(...prices)
    return prices
}

function waitSignerOnPrice(ctx, raw, pubkey, {since, timeout = 25 * minute}) {
    const admins = [...new Set(oracles(raw).map(c => c.admin))]
    return ctx.wait(async () => {
        for (const admin of admins) {
            const txs = await ctx.chain.recentTransactions(admin, {since, knownPubkeys: knownPubkeys(raw)})
            const signed = txs.find(tx => isPriceUpdate(tx) && tx.signers.includes(pubkey))
            if (signed) {
                ctx.observed.push(signed)
                return signed
            }
        }
        return null
    }, {timeout, every: 30000, describe: `a price update signed by ${short(pubkey)}`})
}

/**
 * Every admin account of the config lists the key at the weight, with thresholds at the majority of the node set
 * @param {object} ctx - runner context
 * @param {object} raw - the config now in force
 * @param {string} pubkey - node key
 * @param {number} weight - expected weight, 0 for "not a signer"
 */
async function expectSigner(ctx, raw, pubkey, weight) {
    const majority = getMajority(Object.keys(raw.nodes).length)
    const accounts = [raw.systemAccount, ...new Set(Object.values(raw.contracts).map(c => c.admin))]
    await ctx.wait(async () => {
        for (const account of accounts) {
            const {signers, thresholds} = await ctx.chain.accountSigners(account)
            if ((signers[pubkey] || 0) !== weight)
                throw new Error(`${short(account)} lists ${short(pubkey)} at weight ${signers[pubkey] || 0}, expected ${weight}`)
            if (thresholds.med !== majority)
                throw new Error(`${short(account)} has threshold ${thresholds.med}, expected ${majority}`)
        }
        return true
    }, {timeout: 2 * minute, every: 10000, describe: `signer weights of ${short(pubkey)}`})
}

/**
 * Runs every restore step even when an earlier one fails, then reports the failures together
 * @param {...function(): Promise} steps - restore steps
 * @returns {Promise<void>}
 */
async function restoreAll(...steps) {
    const errors = []
    for (const step of steps) {
        try {
            await step()
        } catch (err) {
            errors.push(err.message)
        }
    }
    if (errors.length)
        throw new Error(errors.join('; '))
}

module.exports = {
    restoreAll,
    signerKey,
    current,
    memberKeys,
    knownPubkeys,
    runningMembers,
    vote,
    propose,
    withdraw,
    isRoundRefusal,
    waitPending,
    waitApplied,
    waitNodesOn,
    applyChange,
    oracles,
    waitTicks,
    priceTransactions,
    waitSignerOnPrice,
    expectSigner
}
