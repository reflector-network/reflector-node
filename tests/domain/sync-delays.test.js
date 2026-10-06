/*eslint-disable no-undef */
const container = require('../../src/domain/container')
const {priceSyncDelay, roundSyncDelay} = require('../../src/domain/sync-delays')
const OracleRunner = require('../../src/domain/runners/oracle-runner')
const PriceRunner = require('../../src/domain/runners/price-runner')
const SubscriptionsRunner = require('../../src/domain/runners/subscriptions-runner')
const TradesManager = require('../../src/domain/prices/trades-manager')
const {stopTradesManagersAfterEach} = require('../helpers/stop-trades-managers')

stopTradesManagersAfterEach(TradesManager)

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const minute = 60 * 1000

describe('the sync delays are the same on every node', () => {
    beforeEach(() => {
        //an old app.config.json may still carry dbSyncDelay; nothing reads it any more
        container.settingsManager = {appConfig: {dbSyncDelay: 3_000}, getPriceHeartbeat: () => 120 * minute}
    })

    test('trades are gossiped 15 s after the minute, and rounds start 5 s later', () => {
        expect(priceSyncDelay).toBe(15_000)
        expect(roundSyncDelay).toBe(20_000)
    })

    test('oracle and subscriptions rounds start at the round delay, whatever the node config says', () => {
        expect(new OracleRunner(CONTRACT_ID).__delay).toBe(roundSyncDelay)
        expect(new SubscriptionsRunner(CONTRACT_ID).__delay).toBe(roundSyncDelay)
    })

    test('the price runner gossips at the price delay, whatever the node config says', () => {
        expect(new PriceRunner().__delay).toBe(priceSyncDelay)
    })

    test('a minute stops waiting for peers 25 s after its gossip', () => {
        const timestamp = Math.floor(Date.now() / minute) * minute - 2 * minute
        const sync = new TradesManager().__getOrAddTimestampSync('exchanges_USD', timestamp)
        expect(sync.maxTime).toBe(timestamp + priceSyncDelay + 25_000)
    })
})
