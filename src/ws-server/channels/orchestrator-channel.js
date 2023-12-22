const ChannelTypes = require('./channel-types')
const OutgoingChannelBase = require('./outgoing-channel-base')

class OrchestratorChannel extends OutgoingChannelBase {

    constructor(url) {
        super(null, url)
    }

    __onOpen() {
        super.__onOpen()
        this.validated()
    }


    get headers() {
        return {app: 'node'}
    }

    type = ChannelTypes.ORCHESTRATOR
}

module.exports = OrchestratorChannel