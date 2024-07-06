const ChannelTypes = require('../channels/channel-types')
const NodeStates = require('../../domain/nodes/node-states')
const runnerManager = require('../../domain/runners/runner-manager')
const BaseHandler = require('./base-handler')


class StateHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING

    async handle(ws, message) {
        switch (message.data.state) {
            case NodeStates.READY: {
                const promises = []
                for (const oracleRunner of runnerManager.all()) {
                    promises.push(oracleRunner.broadcastSignatureTo(ws.pubkey))
                }
                await Promise.allSettled(promises)
            }
                break
            default:
                throw new Error(`State ${message.data.state} is not supported`)
        }
    }
}
module.exports = StateHandler