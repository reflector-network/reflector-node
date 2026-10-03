/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const {verifyNotifications} = require('./subscription')

const contract = 'CSUBS'
const nodes = [Keypair.random(), Keypair.random(), Keypair.random()]
const members = nodes.map(kp => kp.publicKey())

//the body a node posts directly to a webhook: the update it signed, with the fields a gateway would restore put back
function body(kp, {subscription = '7', signWith = kp, contractId = contract} = {}) {
    const update = {contract: contractId, events: ['aa'], event: {subscription, price: '1', prevPrice: '1', timestamp: 1}, root: 'bb'}
    const signature = Buffer.from(signWith.sign(Buffer.from(JSON.stringify(sortObjectKeys(update))))).toString('base64')
    return {update, signature, verifier: kp.publicKey()}
}

const request = data => ({method: 'POST', content: JSON.stringify(data)})

describe('verifyNotifications', () => {
    test('counts each member that posted a valid notification for the subscription once', () => {
        const requests = [request(body(nodes[0])), request(body(nodes[1])), request(body(nodes[1]))]

        const result = verifyNotifications(requests, {contractId: contract, subscriptionId: 7n, members})

        expect(result.verifiers.sort()).toEqual([members[0], members[1]].sort())
        expect(result.problems).toEqual([])
    })

    test('a notification whose signature does not verify is a problem and does not count', () => {
        const requests = [request(body(nodes[0], {signWith: nodes[2]}))]

        const result = verifyNotifications(requests, {contractId: contract, subscriptionId: 7n, members})

        expect(result.verifiers).toEqual([])
        expect(result.problems).toEqual([`invalid signature from ${members[0].slice(0, 8)}`])
    })

    test('a notification signed by a key outside the cluster is a problem', () => {
        const outsider = Keypair.random()

        const result = verifyNotifications([request(body(outsider))], {contractId: contract, subscriptionId: 7n, members})

        expect(result.verifiers).toEqual([])
        expect(result.problems).toEqual([`notification from ${outsider.publicKey().slice(0, 8)}, not a cluster node`])
    })

    test('notifications for another subscription or contract are ignored, not problems', () => {
        const requests = [request(body(nodes[0], {subscription: '8'})), request(body(nodes[1], {contractId: 'COTHER'}))]

        const result = verifyNotifications(requests, {contractId: contract, subscriptionId: 7n, members})

        expect(result).toEqual({verifiers: [], problems: []})
    })

    test('requests that are not a notification are ignored', () => {
        const requests = [{method: 'GET', content: ''}, {method: 'POST', content: 'not json'}, {method: 'POST', content: '{}'}]

        expect(verifyNotifications(requests, {contractId: contract, subscriptionId: 7n, members})).toEqual({verifiers: [], problems: []})
    })
})

describe('encryptWebhook', () => {
    test('a node holding the cluster secret decrypts the url', async () => {
        const {generateKeyPairSync} = require('crypto')
        const {importRSAKey, decrypt} = require('../../../src/utils/crypto-helper')
        const {encryptWebhook} = require('./subscription')
        const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
        const clusterSecret = privateKey.export({format: 'der', type: 'pkcs8'}).toString('base64')

        const encrypted = await encryptWebhook(clusterSecret, 'https://webhook.example/abc')
        const decrypted = await decrypt(await importRSAKey(Buffer.from(clusterSecret, 'base64')), encrypted)

        expect(Buffer.from(decrypted).toString()).toBe('https://webhook.example/abc')
    })
})

describe('retentionFee', () => {
    const {retentionFee} = require('./subscription')

    test('mirrors the contract: the reference heartbeat is 120 minutes, and the fee never drops below the base fee', () => {
        expect(retentionFee(1000, 5, true)).toBe(4898n) //the contract burned 2 x 4898 to create such a subscription
        expect(retentionFee(2000, 5, true)).toBe(9797n)
        expect(retentionFee(1000, 200, true)).toBe(1000n)
    })

    test('a pair priced from two sources costs twice as much', () => {
        expect(retentionFee(1000, 5, false)).toBe(9796n)
    })
})
