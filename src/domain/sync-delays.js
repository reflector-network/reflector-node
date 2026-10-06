//When every node acts on a minute that has just closed. The delays are the same on every node and are not configurable:
//a round starts its submit schedule at its tick plus roundSyncDelay, so a node waiting longer or shorter than its peers
//would sign transactions with other timebounds, and their signatures would never add up to a majority

//the price runner loads the closed minute's trades and gossips them this long after the minute ends
const priceSyncDelay = 15_000
//oracle and subscriptions rounds start this long after their tick, once the gossip had time to arrive
const roundSyncDelay = priceSyncDelay + 5_000

module.exports = {priceSyncDelay, roundSyncDelay}
