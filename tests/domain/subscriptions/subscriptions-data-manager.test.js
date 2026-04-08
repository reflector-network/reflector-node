/*eslint-disable no-undef */
const {SubscriptionContractManager} = require('../../../src/domain/subscriptions/subscriptions-data-manager')

describe('SubscriptionsDataManager', () => {
    afterAll(() => {
        const container = require('../../../src/domain/container')
        container.settingsManager.dispose()
    })

    it.skip('process events', async () => {

        const container = require('../../../src/domain/container')
        container.homeDir = './tests/cluster/clusterData/node0/reflector-home'
        container.settingsManager = new (require('../../../src/domain/settings-manager'))()
        container.tradesManager = new (require('../../../src/domain/prices/trades-manager'))()
        await container.settingsManager.init()

        const contractId = 'CDQ7EZ2GG6LI6VKKY3UKDT4QGMNEJZGT2ANR7QCB65XVIXZTQ2CHBXU4'
        const manager = new SubscriptionContractManager(contractId)

        await manager.processLastEvents()
    }, 3000000)
})