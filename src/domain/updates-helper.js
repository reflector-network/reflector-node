const Asset = require('../models/assets/asset')
const AssetsUpdate = require('../models/contract/updates/assets-update')
const NodesUpdate = require('../models/contract/updates/nodes-update')
const PeriodUpdate = require('../models/contract/updates/period-update')
const ContractUpdate = require('../models/contract/updates/contract-update')
const UpdateType = require('../models/contract/updates/update-type')

function buildUpdate(rawUpdate) {
    switch (rawUpdate.type) {
        case UpdateType.NODES:
            return new NodesUpdate(rawUpdate.timestamp, rawUpdate.nodes)
        case UpdateType.ASSETS:
            return new AssetsUpdate(
                rawUpdate.timestamp,
                rawUpdate.assets.map(a => new Asset(a.type, a.code))
            )
        case UpdateType.PERIOD:
            return new PeriodUpdate(rawUpdate.timestamp, rawUpdate.period)
        case UpdateType.CONTRACT:
            return new ContractUpdate(rawUpdate.timestamp, rawUpdate.wasmHash)
        default:
            throw new Error('Invalid update type')
    }
}

module.exports = {
    buildUpdate
}