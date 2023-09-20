const {TransactionBuilder, Operation} = require('soroban-client')
const AssetsPendingTransaction = require('../models/blockchain/transactions/assets-pending-transaction')
const {getMajority} = require('../utils/majority-helper')
const UpdateType = require('../models/contract/updates/update-type')
const NodesPendingTransaction = require('../models/blockchain/transactions/nodes-pending-transaction')
const PeriodPendingTransaction = require('../models/blockchain/transactions/period-pending-transaction')

/**
 * @typedef {import('../models/contract/updates/update-base')} UpdateBase
 * @typedef {import('soroban-client').Account} Account
 * @typedef {import('@reflector-network/oracle-client')} OracleClient
 * @typedef {import('../domain/settings-manager')} SettingsManager
 */

/**
 * @param {UpdateBase} update - pending update
 * @param {Account} account - account
 * @param {any} txOptions - transaction options
 * @param {OracleClient} orcaleClient - oracle client
 * @param {SettingsManager} settingsManager - settings manager
 * @returns {Promise<AssetsPendingTransaction|NodesPendingTransaction|PeriodPendingTransaction>}
 */
async function buildUpdateTransaction(update, account, txOptions, orcaleClient, settingsManager) {
    switch (update.type) {
        case UpdateType.ASSETS:
        {
            try {
                const tx = await orcaleClient.addAssets(
                    account,
                    update.assets,
                    txOptions
                )
                return new AssetsPendingTransaction(tx, update.timestamp, update.assets)
            } catch (e) {
                console.error('Error on building adding assets transaction')
                console.error(e)
                return null
            }
        }
        case UpdateType.NODES:
        {
            const currentNodes = settingsManager.contractSettings.nodes
            let currentNodesLength = currentNodes.length
            const options = structuredClone(txOptions)
            options.networkPassphrase = settingsManager.contractSettings.network
            const txBuilder = new TransactionBuilder(account, options)
            let isOptionsChanged = false
            for (const node of update.nodes) {
                if (!node.remove && currentNodes.find(pubkey => pubkey === node.pubkey))
                    continue //node already exists, and not removed. Skip
                const weight = node.remove ? 0 : 1
                currentNodesLength += weight ? 1 : -1
                txBuilder.addOperation(Operation.setOptions({
                    signer: {
                        ed25519PublicKey: node.pubkey,
                        weight
                    }
                }))
                isOptionsChanged = true
            }
            if (!isOptionsChanged)
                return null
            const currentMajority = getMajority(currentNodesLength)
            txBuilder.addOperation(Operation.setOptions({
                lowThreshold: currentMajority,
                medThreshold: currentMajority,
                highThreshold: currentMajority
            }))
                .setTimeout(0)
            return new NodesPendingTransaction(txBuilder.build(), update.timestamp, update.nodes)
        }
        case UpdateType.PERIOD:
        {
            const tx = await orcaleClient.setPeriod(
                account,
                update.period,
                txOptions
            )
            return new PeriodPendingTransaction(tx, update.timestamp, update.period)
        }
        default:
            throw new Error(`Unknown update type: ${update.type}`)
    }
}

module.exports = {
    buildUpdateTransaction
}