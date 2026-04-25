/**
 * @typedef {import('./subscriptions-sync-data')} SubscriptionsSyncData
 */

class PendingSyncDataCache {

    /**
     * @type {Object.<string, SubscriptionsSyncData>}
     */
    __notificationsData = {}

    /**
     * @param {SubscriptionsSyncData} newItem - new item
     * @returns {SubscriptionsSyncData} - current item
     */
    push(newItem) {
        if (!newItem.hashBase64)
            throw new Error('SubscriptionsSyncData.hashBase64 must be set before push (call calculateHash first)')
        let currentItem = this.__notificationsData[newItem.hashBase64]
        //if data not found, register new one
        if (!currentItem)
            currentItem = this.__notificationsData[newItem.hashBase64] = newItem
        else //update signatures
            currentItem.merge(newItem)
        this.__cleanup()
        return currentItem
    }

    __cleanup() {
        const now = Date.now()
        const threshold = 60 * 2 * 1000
        for (const key in this.__notificationsData)
            if (this.__notificationsData[key].timestamp < now - threshold)
                delete this.__notificationsData[key]
    }
}

module.exports = PendingSyncDataCache