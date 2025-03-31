const ChannelTypes = require('../channels/channel-types')
const NodeStates = require('../../domain/nodes/node-states')
const runnerManager = require('../../domain/runners/runner-manager')
const SubscriptionsRunner = require('../../domain/runners/subscriptions-runner')
const container = require('../../domain/container')
const BaseHandler = require('./base-handler')


class StateHandler extends BaseHandler {

    allowedChannelTypes = ChannelTypes.OUTGOING

    handle(ws, message) {
        switch (message.data.state) {
            case NodeStates.READY: {
                for (const runner of runnerManager.all()) {
                    runner.broadcastSignatureTo(ws.pubkey)
                    if (runner instanceof SubscriptionsRunner) {
                        runner.broadcastSyncData()
                    }
                }
                container.tradesManager.sendTradesData(ws.pubkey)
            }
                break
            default:
                throw new Error(`State ${message.data.state} is not supported`)
        }
    }
}
module.exports = StateHandler