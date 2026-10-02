/*eslint-disable no-undef */
const {withDatabase, buildAppConfig, newDatabaseName} = require('./orchestrator-process')

describe('orchestrator process config', () => {
    test('withDatabase swaps the database name and keeps host and options', () => {
        expect(withDatabase('mongodb://127.0.0.1:27017/reflector-orchestrator-test-suit', 'e2e-1'))
            .toBe('mongodb://127.0.0.1:27017/e2e-1')
        expect(withDatabase('mongodb://user:pass@db.local:27017/old?directConnection=true', 'e2e-2'))
            .toBe('mongodb://user:pass@db.local:27017/e2e-2?directConnection=true')
    })

    test('buildAppConfig copies the template with the database, port and default node set', () => {
        const template = {port: 1, dbConnectionString: 'mongodb://127.0.0.1:27017/x', defaultNodes: ['OLD'], emailSettings: {apiKey: 'k'}}
        const config = buildAppConfig(template, {dbName: 'e2e-3', port: 12274, defaultNodes: ['G1']})
        expect(config).toEqual({port: 12274, dbConnectionString: 'mongodb://127.0.0.1:27017/e2e-3', defaultNodes: ['G1'], emailSettings: {apiKey: 'k'}})
        expect(template.port).toBe(1)
    })

    test('a new database name is unique per call and marks the runner', () => {
        const a = newDatabaseName()
        const b = newDatabaseName()
        expect(a).toMatch(/^reflector-orchestrator-e2e-\d+-[0-9a-f]{4}$/)
        expect(a).not.toBe(b)
    })
})
