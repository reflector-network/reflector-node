/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')

let dir
let nodes

function home(index) {
    return path.join(dir, `node${index}`, 'reflector-home')
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nodes-'))
    process.env.E2E_CLUSTER_DIR = dir
    jest.resetModules()
    nodes = require('./nodes')
    fs.mkdirSync(path.join(home(1), 'logs'), {recursive: true})
    fs.writeFileSync(path.join(home(1), 'app.config.json'), JSON.stringify({port: 30447, dataSources: {exchanges: {type: 'api', name: 'exchanges'}}}))
})

afterEach(() => {
    delete process.env.E2E_CLUSTER_DIR
    fs.rmSync(dir, {recursive: true, force: true})
})

describe('nodes', () => {
    test('a container runs the image on the host network with the node home mounted', () => {
        expect(nodes.runArgs(1)).toEqual([
            'run', '-d', '--network', 'host',
            '-v', `${path.resolve(home(1))}:/reflector-node/app/home`,
            '--restart=unless-stopped', '--name=node1', 'reflector-node-dev'
        ])
    })

    test('a second edit keeps the first backup, so restore returns the original', () => {
        nodes.editAppConfig(1, c => {
            c.dataSources.exchanges.providers = ['binance']
        })
        nodes.editAppConfig(1, c => {
            c.dataSources.exchanges.providers = ['okx']
        })
        expect(nodes.readAppConfig(1).dataSources.exchanges.providers).toEqual(['okx'])
        expect(nodes.restoreAppConfig(1)).toBe(true)
        expect(nodes.readAppConfig(1).dataSources.exchanges.providers).toBeUndefined()
        expect(nodes.restoreAppConfig(1)).toBe(false)
    })

    test('readLogLines returns entries since a time from every combined log, oldest first', () => {
        const logs = path.join(home(1), 'logs')
        fs.writeFileSync(path.join(logs, '20261001-1500-01-combined.log'), [
            JSON.stringify({level: 'error', time: '2026-10-01T15:00:00.000Z', msg: 'old'}),
            JSON.stringify({level: 'error', time: '2026-10-01T15:10:00.000Z', msg: 'b'})
        ].join('\n') + '\n')
        fs.writeFileSync(path.join(logs, 'combined.log'), [
            JSON.stringify({level: 'info', time: '2026-10-01T15:20:00.000Z', msg: 'c'}),
            'not json'
        ].join('\n'))
        fs.writeFileSync(path.join(logs, 'error.log'), JSON.stringify({level: 'error', time: '2026-10-01T15:30:00.000Z', msg: 'x'}))
        const entries = nodes.readLogLines(1, Date.parse('2026-10-01T15:05:00.000Z'))
        expect(entries.map(e => e.msg)).toEqual(['b', 'c'])
    })

    test('resetJoinState removes the stored config, pending update and nonces only', () => {
        for (const f of ['.config.json', '.pending.config.json', '.nonce.json'])
            fs.writeFileSync(path.join(home(1), f), '{}')
        nodes.resetJoinState(1)
        expect(fs.readdirSync(home(1)).sort()).toEqual(['app.config.json', 'logs'])
    })
})

describe('editedHomes', () => {
    test('lists the nodes whose app config still carries a scenario edit', () => {
        jest.resetModules()
        const fresh = require('./nodes')
        expect(fresh.editedHomes()).toEqual([])
        fresh.editAppConfig(1, c => {
            c.port = 1
        })
        expect(fresh.editedHomes()).toEqual([1])
    })
})

describe('startHistory', () => {
    test('keeps every start, not only the latest per node', () => {
        jest.resetModules()
        const fresh = require('./nodes')
        fresh.recordStart(1, 1000)
        fresh.recordStart(1, 2000)
        fresh.recordStart(2, 3000)
        expect(fresh.startHistory()).toEqual([1000, 2000, 3000])
        expect(fresh.startTimes()).toEqual({1: 2000, 2: 3000})
    })
})
