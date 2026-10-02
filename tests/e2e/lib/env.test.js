/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {Keypair} = require('@stellar/stellar-sdk')

let dir
let env

function writeNode(index, keypair, extra = {}) {
    const home = path.join(dir, `node${index}`, 'reflector-home')
    fs.mkdirSync(home, {recursive: true})
    fs.writeFileSync(path.join(home, 'app.config.json'), JSON.stringify({secret: keypair.secret(), port: 1, ...extra}))
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-env-'))
    process.env.E2E_CLUSTER_DIR = dir
    jest.resetModules()
    env = require('./env')
})

afterEach(() => {
    delete process.env.E2E_CLUSTER_DIR
    fs.rmSync(dir, {recursive: true, force: true})
})

describe('env', () => {
    test('listNodes reads every node home in index order with its key', () => {
        const a = Keypair.random()
        const b = Keypair.random()
        writeNode(2, b)
        writeNode(0, a)
        fs.mkdirSync(path.join(dir, 'node1'))
        const nodes = env.listNodes()
        expect(nodes.map(n => n.index)).toEqual([0, 2])
        expect(nodes.map(n => n.pubkey)).toEqual([a.publicKey(), b.publicKey()])
    })

    test('spareKeys are generated once and kept', () => {
        const first = env.spareKeys()
        expect(first).toHaveLength(2)
        jest.resetModules()
        expect(require('./env').spareKeys()).toEqual(first)
    })

    test('knownKeys lists homed nodes, then spares that have no home', () => {
        const a = Keypair.random()
        writeNode(0, a)
        const spares = env.spareKeys()
        writeNode(1, Keypair.fromSecret(spares[0].secret))
        const keys = env.knownKeys()
        expect(keys.map(k => k.pubkey)).toEqual([a.publicKey(), spares[0].pubkey, spares[1].pubkey])
        expect(keys.map(k => k.index)).toEqual([0, 1, null])
        expect(env.keypairOf(spares[1].pubkey).secret()).toBe(spares[1].secret)
        expect(() => env.keypairOf(Keypair.random().publicKey())).toThrow('No local secret')
    })

    test('createNodeHome takes the next index and port and drops a stale config hash', () => {
        writeNode(0, Keypair.random())
        writeNode(1, Keypair.random())
        const kp = Keypair.random()
        const node = env.createNodeHome(kp, {secret: 'x', port: 1, clusterConfigHash: 'a'.repeat(64), trace: true})
        expect(node.index).toBe(2)
        expect(node.appConfig).toEqual({secret: kp.secret(), port: 30547, trace: true})
        expect(env.listNodes().map(n => n.pubkey)).toContain(kp.publicKey())
    })
})
