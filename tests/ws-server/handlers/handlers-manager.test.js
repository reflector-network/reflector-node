/*eslint-disable no-undef */
const HandlersManager = require('../../../src/ws-server/handlers/handlers-manager')
const MessageTypes = require('../../../src/ws-server/handlers/message-types')
const ChannelTypes = require('../../../src/ws-server/channels/channel-types')

describe('HandlersManager', () => {
    let manager
    let handler

    beforeEach(() => {
        handler = {
            allowAnonymous: false,
            allowedChannelTypes: [ChannelTypes.INCOMING],
            handle: jest.fn().mockResolvedValue('handled')
        }

        manager = new HandlersManager()
        manager.handlers = {
            [MessageTypes.HANDSHAKE_RESPONSE]: handler
        }
    })

    test('throws when message type is unsupported', async () => {
        const channel = {isValidated: true, type: ChannelTypes.INCOMING}
        const message = {type: 999}

        await expect(manager.handle(channel, message)).rejects.toThrow('Message type 999 is not supported')
    })

    test('throws when anonymous channel sends message to non-anonymous handler', async () => {
        const channel = {isValidated: false, type: ChannelTypes.INCOMING}
        const message = {type: MessageTypes.HANDSHAKE_RESPONSE}

        await expect(manager.handle(channel, message)).rejects.toThrow(
            `Message type ${MessageTypes.HANDSHAKE_RESPONSE} is not allowed for anonymous channel`
        )
        expect(handler.handle).not.toHaveBeenCalled()
    })

    test('throws when handler does not support channel type', async () => {
        const channel = {isValidated: true, type: ChannelTypes.ORCHESTRATOR}
        const message = {type: MessageTypes.HANDSHAKE_RESPONSE}

        await expect(manager.handle(channel, message)).rejects.toThrow(/not supported for channel/)
        expect(handler.handle).not.toHaveBeenCalled()
    })

    test('delegates to handler.handle and returns its result', async () => {
        const channel = {isValidated: true, type: ChannelTypes.INCOMING}
        const message = {type: MessageTypes.HANDSHAKE_RESPONSE}

        const result = await manager.handle(channel, message)

        expect(result).toBe('handled')
        expect(handler.handle).toHaveBeenCalledWith(channel, message)
    })

    test('allows anonymous channel when handler permits anonymous access', async () => {
        handler.allowAnonymous = true
        const channel = {isValidated: false, type: ChannelTypes.INCOMING}
        const message = {type: MessageTypes.HANDSHAKE_RESPONSE}

        const result = await manager.handle(channel, message)

        expect(result).toBe('handled')
        expect(handler.handle).toHaveBeenCalledWith(channel, message)
    })
})
