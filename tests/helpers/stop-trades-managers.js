/*eslint-disable no-undef */
/**
 * Stops, after every test of the suite that requires this file, each TradesManager the test constructed, so no
 * cleanup worker or sync-entry deadline outlives the suite. The constructor arms the cleanup worker, so a spy on
 * that method sees every instance whichever way the suite builds it.
 * @param {Function} TradesManager - the class the suite constructs
 */
function stopTradesManagersAfterEach(TradesManager) {
    const created = []
    const armWorker = TradesManager.prototype.__clearPendingTradesDataWorker
    TradesManager.prototype.__clearPendingTradesDataWorker = function () {
        if (!created.includes(this))
            created.push(this)
        return armWorker.call(this)
    }
    afterEach(() => {
        for (const tradesManager of created.splice(0))
            tradesManager.stop()
    })
    afterAll(() => {
        TradesManager.prototype.__clearPendingTradesDataWorker = armWorker
    })
}

module.exports = {stopTradesManagersAfterEach}
