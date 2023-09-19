const Asset = require('../models/assets/asset')
const AssetsUpdate = require('../models/contract/updates/assets-update')
const NodesUpdate = require('../models/contract/updates/nodes-update')
const PeriodUpdate = require('../models/contract/updates/period-update')
const UpdateType = require('../models/contract/updates/update-type')

function buildUpdate(rawUpdate, network) {
    switch (rawUpdate.type) {
        case UpdateType.NODES:
            return new NodesUpdate(rawUpdate.timestamp, rawUpdate.nodes)
        case UpdateType.ASSETS:
            return new AssetsUpdate(
                rawUpdate.timestamp,
                rawUpdate.assets.map(a => new Asset(a.type, a.code, network))
            )
        case UpdateType.PERIOD:
            return new PeriodUpdate(rawUpdate.timestamp, rawUpdate.period)
        default:
            throw new Error('Invalid update type')
    }
}

module.exports = {
    buildUpdate
}