/*eslint-disable no-undef */
jest.mock('../../src/domain/container', () => ({
    settingsManager: {appConfig: {publicKey: 'self-pubkey'}},
    handlersManager: {handle: jest.fn()}
}))

const {Server, WebSocket} = require('ws')
const WsServer = require('../../src/ws-server/index')

test('a frame above maxPayload closes the socket with 1009', async () => {
    const options = new WsServer().__getServerOptions(0)
    const server = new Server(options)
    server.on('connection', ws => ws.on('error', () => {}))
    await new Promise(resolve => server.once('listening', resolve))
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`)
    await new Promise(resolve => client.once('open', resolve))
    const closed = new Promise(resolve => client.once('close', code => resolve(code)))

    client.send(Buffer.alloc(options.maxPayload + 1))

    await expect(closed).resolves.toBe(1009)
    server.close()
})
