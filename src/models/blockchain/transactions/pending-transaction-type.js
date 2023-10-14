/**
 * Enum asset type
 * @readonly
 * @enum {number}
 */
const PendingTransactionType = {
    INIT: 1,
    NODES_UPDATE: 2,
    ASSETS_UPDATE: 3,
    PERIOD_UPDATE: 4,
    PRICE_UPDATE: 5,
    CONTRACT_UPDATE: 6
}

module.exports = PendingTransactionType