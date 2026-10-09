const {getMajority} = require('@reflector/reflector-shared')
const {SubscriptionsClient} = require('@reflector/reflector-shared')
const flow = require('../lib/flow')
const {contractOf} = require('../lib/config')
const {settings} = require('../lib/env')
const webhookSite = require('../lib/webhook-site')
const {tokenIssuer, encryptWebhook, verifyNotifications, retentionFee} = require('../lib/subscription')

const minute = 60000
//the shortest heartbeat the contract accepts: a trigger is due at most this long after the subscription starts
const heartbeat = 5

function client(contract) {
    return new SubscriptionsClient(settings.passphrase, settings.sorobanRpc, contract.contractId)
}

function txOptions() {
    return {fee: 1000000, timebounds: {minTime: 0, maxTime: Math.floor((Date.now() + minute) / 1000)}}
}

/**
 * Cancels the subscription this run created, returning its balance to the owner
 * @param {object} ctx - runner context
 * @returns {Promise<void>}
 */
async function cancelSubscription(ctx) {
    const open = ctx.subscription
    ctx.subscription = null
    if (!open)
        return
    const tx = await client(open.contract).cancel(await ctx.chain.account(open.owner.publicKey()), {subscriptionId: open.id}, txOptions())
    await ctx.chain.submit(tx, open.owner)
    ctx.log(`cancelled subscription ${open.id}`)
}

module.exports = [
    {
        id: 'S1',
        title: 'A subscription is triggered and its webhook notified',
        timeoutMs: 30 * minute,
        async requires(ctx) {
            const {raw} = await flow.current(ctx)
            const contract = contractOf(raw, 'subscriptions')
            if (!contract)
                return 'no subscriptions contract'
            if (!raw.clusterSecret)
                return 'the config has no cluster secret'
            return tokenIssuer(contract.token) ? null : 'no local secret for the subscription token issuer'
        },
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const contract = contractOf(raw, 'subscriptions')
            const owner = tokenIssuer(contract.token)
            const hook = await webhookSite.create()
            ctx.log(`webhook ${hook.view}`)
            const since = Date.now()
            const tx = await client(contract).createSubscription(await ctx.chain.account(owner.publicKey()), {
                owner: owner.publicKey(),
                base: {asset: 'BTC', source: 'exchanges'},
                quote: {asset: 'USDT', source: 'exchanges'},
                //the creation fee and three days; a larger balance would outlive the ledger's maximum TTL
                amount: (retentionFee(contract.baseFee, heartbeat, true) * 5n).toString(),
                threshold: 1, //0.1%
                heartbeat,
                webhook: await encryptWebhook(raw.clusterSecret, hook.url)
            }, txOptions())
            const {returnValue} = await ctx.chain.submit(tx, owner)
            const id = returnValue[0]
            ctx.subscription = {contract, owner, id}
            ctx.log(`created subscription ${id}`)

            const trigger = await ctx.wait(async () => {
                const txs = await ctx.chain.recentTransactions(contract.admin, {since, knownPubkeys: flow.knownPubkeys(raw)})
                return txs.find(t => t.successful && t.calls.some(c => c.contract === contract.contractId && c.fn === 'trigger'))
            }, {timeout: heartbeat * minute + 8 * minute, every: 20000, describe: `a trigger of subscription ${id}`})
            ctx.observed.push(trigger)

            //every node posts its own signed copy; a majority of them is what a subscriber can rely on
            const members = Object.keys(raw.nodes)
            const majority = getMajority(members.length)
            let last = {verifiers: [], problems: []}
            await ctx.wait(async () => {
                const received = await webhookSite.requests(hook.uuid)
                last = verifyNotifications(received, {contractId: contract.contractId, subscriptionId: id, members})
                return last.problems.length > 0 || last.verifiers.length >= majority
            }, {timeout: 3 * minute, every: 15000, describe: `${majority} signed notifications of subscription ${id}`}).catch(err => {
                throw new Error(`${err.message}; ${last.verifiers.length} node(s) notified`)
            })
            if (last.problems.length)
                throw new Error(`The webhook received bad notifications: ${last.problems.join('; ')}`)
            ctx.log(`notified by ${last.verifiers.length} of ${members.length} nodes`)
            await cancelSubscription(ctx)
        },
        restore: cancelSubscription
    }
]
