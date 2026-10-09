/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const {ConfigEnvelope, sortObjectKeys} = require('@reflector/reflector-shared')
const {NonceStore, OrchestratorClient, signConfig} = require('./orchestrator')

const kps = Array.from({length: 3}, () => Keypair.random())

function rawConfig() {
    const nodes = {}
    kps.forEach((kp, i) => {
        nodes[kp.publicKey()] = {pubkey: kp.publicKey(), url: `ws://localhost:${30347 + i * 100}`, domain: `node${i}.e2e.local`}
    })
    return {contracts: {}, nodes, wasmHash: {oracle: 'a'.repeat(64)}, minDate: 0, systemAccount: Keypair.random().publicKey(), network: 'testnet', decimals: 14}
}

//the orchestrator's own check, restated: sha256("<pubkey>:" + JSON.stringify(payload)) signed by the pubkey
function verifyAuth(req, body) {
    const [pubkey, signature, rawNonce] = req.headers.authorization.split('.')
    const nonce = Number(rawNonce)
    const url = new URL(req.url, 'http://localhost')
    const query = Object.fromEntries(url.searchParams)
    const route = url.pathname.substring(1) + '?' + new URLSearchParams(sortObjectKeys({...query, nonce})).toString()
    const payload = req.method === 'GET' ? route : sortObjectKeys({...body, nonce, path: route})
    const hash = createHash('sha256').update(`${pubkey}:${JSON.stringify(payload)}`, 'utf8').digest()
    return Keypair.fromPublicKey(pubkey).verify(hash, Buffer.from(signature, 'hex'))
}

let server
let baseUrl
let received
let dir

beforeEach(async () => {
    received = []
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-orch-'))
    server = http.createServer((req, res) => {
        let text = ''
        req.on('data', chunk => text += chunk)
        req.on('end', () => {
            const body = text ? JSON.parse(text) : undefined
            received.push({req, body, valid: req.headers.authorization ? verifyAuth(req, body) : null})
            if (req.url.startsWith('/fail')) {
                res.writeHead(400, {'content-type': 'application/json'})
                return res.end(JSON.stringify({error: 'Config doesn\'t have any changes'}))
            }
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({ok: 1}))
        })
    })
    await new Promise(resolve => server.listen(0, resolve))
    baseUrl = `http://localhost:${server.address().port}`
})

afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, {recursive: true, force: true})
})

describe('NonceStore', () => {
    test('is strictly increasing per key and survives a reload', () => {
        const file = path.join(dir, 'nonces.json')
        const store = new NonceStore(file)
        const a = store.next('A')
        const b = store.next('A')
        expect(b).toBeGreaterThan(a)
        fs.writeFileSync(file, JSON.stringify({A: Date.now() + 10_000_000}))
        const later = new NonceStore(file).next('A')
        expect(later).toBe(JSON.parse(fs.readFileSync(file, 'utf8')).A)
        expect(later).toBeGreaterThan(Date.now() + 9_000_000)
    })
})

describe('OrchestratorClient', () => {
    test('signs a GET the way the orchestrator checks it', async () => {
        const client = new OrchestratorClient({baseUrl, nonces: new NonceStore(path.join(dir, 'n.json'))})
        await client.getConfig(kps[0])
        expect(received[0].req.url).toBe('/config')
        expect(received[0].valid).toBe(true)
    })

    test('signs a POST over the body and the route, and the config signature verifies', async () => {
        const client = new OrchestratorClient({baseUrl, nonces: new NonceStore(path.join(dir, 'n.json'))})
        const raw = rawConfig()
        await client.submit(kps[1], raw, {timestamp: 0, description: 'test'})
        const {body, valid} = received[0]
        expect(valid).toBe(true)
        expect(body.expirationDate).toBeGreaterThan(Date.now() + 7 * 24 * 60 * 60 * 1000)
        const verification = new ConfigEnvelope(body).verifySignatures(kps.map(k => k.publicKey()))
        expect(verification.valid).toBe(true)
        expect(verification.accepted).toEqual([kps[1].publicKey()])
    })

    test('a rejecting signature verifies as a rejection', () => {
        const raw = rawConfig()
        const signature = signConfig(kps[2], raw, 5, true)
        const envelope = new ConfigEnvelope({config: raw, signatures: [signature], timestamp: 0})
        const verification = envelope.verifySignatures(kps.map(k => k.publicKey()))
        expect(verification.rejected).toEqual([kps[2].publicKey()])
    })

    test('a refusal throws with the status and the orchestrator message', async () => {
        const client = new OrchestratorClient({baseUrl: baseUrl + '/fail', nonces: new NonceStore(path.join(dir, 'n.json'))})
        await expect(client.statistics()).rejects.toMatchObject({status: 400, message: expect.stringContaining('doesn\'t have any changes')})
    })

    test('an unreachable orchestrator throws naming the route', async () => {
        const client = new OrchestratorClient({baseUrl: 'http://127.0.0.1:9', nonces: new NonceStore(path.join(dir, 'n.json'))})
        await expect(client.statistics()).rejects.toMatchObject({status: null, message: expect.stringContaining('GET /statistics')})
    })
})
