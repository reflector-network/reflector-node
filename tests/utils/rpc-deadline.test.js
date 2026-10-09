/*eslint-disable no-undef */
const http = require('http')
const {rpc} = require('@stellar/stellar-sdk')

//sdk 17.0.1's rpc.Server forwards only `headers` from its constructor options and drops `timeout`; the deadline set on
//httpClient.defaults is what the fetch adapter turns into an AbortSignal, so this pins the mechanism makeServerRequest uses
describe('rpc deadline mechanism', () => {
    let server
    let url

    beforeAll(async () => {
        server = http.createServer(() => {}) //accepts the request and never answers
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        url = `http://127.0.0.1:${server.address().port}`
    })

    afterAll(async () => {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    })

    test('a server that never answers fails at the deadline set on the http client', async () => {
        const rpcServer = new rpc.Server(url, {allowHttp: true, timeout: 300})
        rpcServer.httpClient.defaults.timeout = 300
        const start = Date.now()
        await expect(rpcServer.getLatestLedger()).rejects.toThrow(/timeout of 300 ?ms exceeded/)
        expect(Date.now() - start).toBeLessThan(3000)
    })
})

describe('makeServerRequest deadline', () => {
    test('every rpc server is built with a 15 s deadline on its http client', async () => {
        jest.resetModules()
        const created = []
        jest.doMock('@stellar/stellar-sdk', () => {
            const actual = jest.requireActual('@stellar/stellar-sdk')
            class Server {
                constructor(serverUrl, options) {
                    this.url = serverUrl
                    this.options = options
                    this.httpClient = {defaults: {}}
                    created.push(this)
                }
            }
            return {...actual, rpc: {...actual.rpc, Server}}
        })
        const {makeServerRequest} = require('../../src/utils/rpc-helper')
        const result = await makeServerRequest(['http://rpc-a'], () => 'ok')
        jest.dontMock('@stellar/stellar-sdk')
        jest.resetModules()

        expect(result).toBe('ok')
        expect(created).toHaveLength(1)
        expect(created[0].options).toEqual({allowHttp: true, timeout: 15000})
        expect(created[0].httpClient.defaults.timeout).toBe(15000)
    })
})
