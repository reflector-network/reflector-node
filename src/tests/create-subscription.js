const fs = require('fs')
const {Config, ContractTypes} = require('@reflector/reflector-shared')
const {SubscriptionsClient} = require('@reflector/oracle-client')
const {Keypair, rpc, scValToNative} = require('@stellar/stellar-sdk')
const axios = require('axios')
const {encrypt, importRSAKey} = require('../utils/crypto-helper')
const quotes = require('../domain/subscriptions/valid-symbols.json')
const config = require('./clusterData/.config.json')
const constants = require('./constants')
const tokenData = require('./token-data.json')
const rsa = require('./rsa.json')
const {getAccountInfo, sendTransaction} = require('./utils')

async function getWebhook() {
    const {uuid} = (await axios.post('https://webhook.site/token'))?.data || {}
    if (!uuid) {
        throw new Error('Webhook not created')
    }

    const key = await importRSAKey(Buffer.from(rsa.pubKey, 'base64'))

    const hook = await encrypt(key, `https://webhook.site/${uuid}`)
    return {
        hook,
        view: `https://webhook.site/#!/view/${uuid}`
    }
}

function saveWebhook(id, hook) {
    let data = {}
    if (fs.existsSync('./tests/webhook.json')) {
        data = JSON.parse(fs.readFileSync('./tests/webhook.json'))
    }
    data[id] = hook
    fs.writeFileSync('./tests/webhook.json', JSON.stringify(data, null, 2))
}

async function createSubscription() {
    const contract = new Config(config)
    const subscriptionContract = [...contract.contracts.values()].find(c => c.type === ContractTypes.SUBSCRIPTIONS)
    if (!subscriptionContract) {
        throw new Error('Subscription contract not found')
    }
    const client = new SubscriptionsClient(constants.network, [constants.rpcUrl], subscriptionContract.contractId)
    const keypair = Keypair.fromSecret(tokenData.secret)
    const server = new rpc.Server(constants.rpcUrl)
    const source = await getAccountInfo(server, keypair.publicKey())

    const webhook = await getWebhook()

    const tx = await client.createSubscription(
        source,
        {
            owner: keypair.publicKey(),
            base: {asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', source: 'pubnet'},
            quote: {asset: 'BTC', source: 'exchanges'},
            amount: '100000',
            threshold: 1,
            heartbeat: 30,
            webhook: webhook.hook
        },
        {
            fee: 1000,
            timebounds: {minTime: 0, maxTime: Math.floor((Date.now() + 30000) / 1000)}
        }
    )
    tx.sign(keypair)

    const result = await sendTransaction(server, tx)

    const [id] = scValToNative(result.returnValue)

    saveWebhook(Number(id), webhook.view)
}

async function cancelSubscriptions() {
    const contract = new Config(config)
    const subscriptionContract = [...contract.contracts.values()].find(c => c.type === ContractTypes.SUBSCRIPTIONS)
    if (!subscriptionContract) {
        throw new Error('Subscription contract not found')
    }
    const client = new SubscriptionsClient(constants.network, [constants.rpcUrl], subscriptionContract.contractId)
    const keypair = Keypair.fromSecret(tokenData.secret)
    const server = new rpc.Server(constants.rpcUrl)

    const arrayRange = (start, end) =>
        [...Array(end - start + 1).keys()].map(i => i + start)

    const subscriptions = arrayRange(5, 6)

    for (const id of subscriptions) {
        try {
            const source = await getAccountInfo(server, keypair.publicKey())
            const tx = await client.cancel(
                source,
                {
                    subscriptionId: id
                },
                {
                    fee: 1000,
                    timebounds: {minTime: 0, maxTime: Math.floor((Date.now() + 30000) / 1000)}
                }
            )
            tx.sign(keypair)

            await sendTransaction(server, tx)
        } catch (err) {
            console.error(`Error cancelling subscription ${id}: ${err.message}`)
        }
    }
}
async function run() {
    for (let i = 0; i < 10; i++) {
        await createSubscription().catch(console.error)
    }
}

//run()
createSubscription().catch(console.error)
//cancelSubscriptions().catch(console.error)