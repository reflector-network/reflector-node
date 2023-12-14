const ChannelTypes = require('./channel-types')
const OutgoingChannelBase = require('./outgoing-channel-base')

class OrchestratorChannel extends OutgoingChannelBase {

    type = ChannelTypes.ORCHESTRATOR
}

module.exports = OrchestratorChannel