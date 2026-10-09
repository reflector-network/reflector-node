/*eslint-disable no-undef */
const SubscriptionProcessor = require('../../../src/domain/subscriptions/subscriptions-processor')
const {getPricesForPair} = require('../../../src/domain/prices/price-manager')

jest.mock('../../../src/domain/prices/price-manager', () => ({
    getPricesForPair: jest.fn()
}))
jest.mock('../../../src/domain/subscriptions/subscriptions-sync-data', () => jest.fn().mockImplementation(({syncData, timestamp}) => ({
    calculateHash: jest.fn().mockResolvedValue(),
    sign: jest.fn()
})))
jest.mock('../../../src/domain/container', () => ({
    settingsManager: {
        appConfig: {
            keypair: 'dummy-keypair'
        }
    }
}))


describe('SubscriptionProcessor', () => {
    let subscriptionManagerMock
    let processor
    const contractId = 'test-contract'
    const timestamp = Date.now()

    beforeEach(() => {
        subscriptionManagerMock = {
            processLastEvents: jest.fn().mockResolvedValue(),
            subscriptions: [],
            lastSyncData: {
                getSyncDataCopy: jest.fn().mockReturnValue({})
            }
        }
        processor = new SubscriptionProcessor(contractId, subscriptionManagerMock)
        getPricesForPair.mockReset()
    })

    it('hands the bound it is given to the event processing unchanged (N-2)', async () => {
        const bound = reads => reads
        await processor.getSubscriptionActions(timestamp, bound)
        expect(subscriptionManagerMock.processLastEvents).toHaveBeenCalledTimes(1)
        expect(subscriptionManagerMock.processLastEvents.mock.calls[0][0]).toBe(bound)
    })

    it('returns no actions on a tick that made the full reload (N-1)', async () => {
        subscriptionManagerMock.processLastEvents.mockResolvedValue(true)
        subscriptionManagerMock.subscriptions = [{id: 1n, status: 0, lastCharge: 0}]
        await expect(processor.getSubscriptionActions(timestamp)).resolves.toBe(null)
        expect(getPricesForPair).not.toHaveBeenCalled()
    })

    it('should process no subscriptions if none are active', async () => {
        subscriptionManagerMock.subscriptions = [
            {status: 1}, //inactive
            {status: 2}  //inactive
        ]
        const result = await processor.getSubscriptionActions(timestamp)
        expect(result.events).toHaveLength(0)
        expect(result.charges).toHaveLength(0)
    })

    it('should add a charge if lastCharge is more than a day ago', async () => {
        const sub = {
            id: 1n,
            base: {source: 'src', asset: {code: 'USD'}},
            quote: {source: 'src', asset: {code: 'EUR'}},
            heartbeat: 10,
            threshold: 1000,
            lastCharge: timestamp - (24 * 60 * 60 * 1000 + 1),
            webhook: [],
            status: 0
        }
        subscriptionManagerMock.subscriptions = [sub]
        getPricesForPair.mockResolvedValue({price: 1000n, decimals: 7})
        const result = await processor.getSubscriptionActions(timestamp)
        expect(result.charges).toContain(sub.id)
    })

    it('should add an event if price diff exceeds threshold', async () => {
        const sub = {
            id: 2n,
            base: {source: 'src', asset: {code: 'BTC'}},
            quote: {source: 'src', asset: {code: 'USD'}},
            heartbeat: 10,
            threshold: 10,
            lastCharge: timestamp,
            webhook: [],
            status: 0
        }
        subscriptionManagerMock.subscriptions = [sub]
        subscriptionManagerMock.lastSyncData.getSyncDataCopy.mockReturnValue({
            [sub.id]: {lastPrice: '1000', lastNotification: timestamp}
        })
        getPricesForPair.mockResolvedValue({price: 1200n, decimals: 7})
        const result = await processor.getSubscriptionActions(timestamp)
        expect(result.events.length).toBe(1)
        expect(result.events[0].id).toBe(sub.id)
    })

    it('should add an event if heartbeat time has passed', async () => {
        const sub = {
            id: 3n,
            base: {source: 'src', asset: {code: 'ETH'}},
            quote: {source: 'src', asset: {code: 'USD'}},
            heartbeat: 1, //1 minute
            threshold: 1000,
            lastCharge: timestamp,
            webhook: [],
            status: 0
        }
        subscriptionManagerMock.subscriptions = [sub]
        subscriptionManagerMock.lastSyncData.getSyncDataCopy.mockReturnValue({
            [sub.id]: {lastPrice: '1000', lastNotification: timestamp - 2 * 60 * 1000}
        })
        getPricesForPair.mockResolvedValue({price: 1000n, decimals: 7})
        const result = await processor.getSubscriptionActions(timestamp)
        expect(result.events.length).toBe(1)
        expect(result.events[0].id).toBe(sub.id)
    })

    it('should handle errors in processing subscriptions gracefully', async () => {
        const sub = {
            id: 4n,
            base: {source: 'src', asset: {code: 'XLM'}},
            quote: {source: 'src', asset: {code: 'USD'}},
            heartbeat: 10,
            threshold: 1000,
            lastCharge: timestamp,
            webhook: [],
            status: 0
        }
        subscriptionManagerMock.subscriptions = [sub]
        getPricesForPair.mockRejectedValue(new Error('Price fetch failed'))
        const result = await processor.getSubscriptionActions(timestamp)
        expect(result.events.length).toBe(0)
        expect(result.charges.length).toBe(0)
    })

    it('should use default syncData if lastSyncData is missing', async () => {
        subscriptionManagerMock.lastSyncData = undefined
        const sub = {
            id: 5n,
            base: {source: 'src', asset: {code: 'DOGE'}},
            quote: {source: 'src', asset: {code: 'USD'}},
            heartbeat: 10,
            threshold: 0,
            lastCharge: timestamp,
            webhook: [],
            status: 0
        }
        subscriptionManagerMock.subscriptions = [sub]
        getPricesForPair.mockResolvedValue({price: 1000n, decimals: 7})
        const result = await processor.getSubscriptionActions(timestamp)
        expect(result.events.length).toBe(1)
    })
})