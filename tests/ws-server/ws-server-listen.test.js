/*eslint-disable no-undef */
jest.mock('../../src/domain/container', () => ({
    settingsManager: {appConfig: {}},
    handlersManager: {handle: jest.fn()}
}))
jest.mock('../../src/ws-server/channels/orchestrator-channel', () => jest.fn())

const net = require('net')
const container = require('../../src/domain/container')
const logger = require('../../src/logger')
const WsServer = require('../../src/ws-server/index')

let exit = null
let server = null

beforeEach(() => {
    jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask']})
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {})
    logger.error.mockClear()
})

afterEach(() => {
    server?.close()
    server = null
    exit.mockRestore()
    jest.useRealTimers()
})

/**
 * @param {number} port - port the node is configured with
 * @returns {WsServer} an initialised server
 */
function startNode(port) {
    container.settingsManager.appConfig = {port, orchestratorUrl: 'wss://127.0.0.1:9'}
    server = new WsServer()
    server.init()
    return server
}

//a node that cannot bind its port (EACCES below 1024 for the image's unprivileged user, EADDRINUSE when the port is
//taken) must not keep running: it would look healthy while no peer can reach it, and the process manager would never
//restart it
test('a node whose port cannot be bound stops, so that it is started again', async () => {
    const taken = net.createServer()
    //the same unspecified address the node binds, so the port is taken for it on every platform
    await new Promise(resolve => taken.listen(0, resolve))
    try {
        const node = startNode(taken.address().port)
        const outcome = await new Promise(resolve => {
            node.wsServer.once('error', () => resolve('error'))
            node.wsServer.once('listening', () => resolve('listening'))
        })
        expect(outcome).toBe('error')

        jest.advanceTimersByTime(3000)

        expect(exit).toHaveBeenCalledWith(13)
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({err: expect.stringContaining('EADDRINUSE')}))
    } finally {
        taken.close()
    }
})

test('an error once the server listens is only logged', async () => {
    const node = startNode(0)
    await new Promise(resolve => node.wsServer.once('listening', resolve))

    node.wsServer.emit('error', new Error('a later server error'))
    jest.advanceTimersByTime(3000)

    expect(exit).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({err: 'a later server error'}))
})
