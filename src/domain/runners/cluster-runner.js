const {buildUpdateTransaction, normalizeTimestamp, areAllSignaturesPresent} = require('@reflector/reflector-shared')
const container = require('../container')
const logger = require('../../logger')
const {getAccount} = require('../../utils')
const nonceManager = require('../../ws-server/nonce-manager')
const RunnerBase = require('./runner-base')
const {isUpdateTimeReached, endsBeforeExpiration} = require('./update-schedule')
const {withPreBuildDeadline} = RunnerBase

const idleWorkerTimeframe = 1000 * 60 * 2 //2 minute

const baseUpdateFee = 10000000

function isPendingConfigExpired(pendingConfig) {
    return pendingConfig.timestamp < Date.now()
}

class ClusterRunner extends RunnerBase {

    async __workerFn(timestamp) {
        const {settingsManager} = container
        const {pendingConfig, config, pendingExpirationDate} = settingsManager
        //inclusive, and decided by the rule node-orchestrator applies (domain/update-schedule.js): both build the update
        //at the tick equal to its switch time, or they build different transactions for one envelope and the
        //orchestrator never confirms the update
        const updateTimeReached = !!pendingConfig && isUpdateTimeReached(pendingConfig.timestamp, timestamp)
        if (!(updateTimeReached || pendingConfig?.allowEarlySubmission))
            return false

        //the orchestrator rejects the update once its expiration date has passed, and does not watch a round it has
        //rejected, so a round that would still be running then is not built: a retry that landed after the rejection
        //left the chain on the new config and the cluster on the old one. The same rule the orchestrator
        //applies to the switch time (update-schedule.js), judged on the tick, never the clock. The date is unsigned
        //orchestrator metadata beside the envelope and never reaches the payload, so a wrong one can only make this node
        //abstain, which the orchestrator can already make it do by withholding the update; without one, every due
        //round is built as before
        if (pendingExpirationDate && !endsBeforeExpiration(timestamp, pendingExpirationDate)) {
            logger.info({
                msg: 'The update round would end after the proposal expires; not building it',
                syncTimestamp: timestamp,
                expirationDate: pendingExpirationDate,
                switchTime: pendingConfig.timestamp
            })
            return false
        }

        //under the inclusive rule an entry with the switch-time tick before that time would build the update early - an
        //overflowed timer did exactly that. So an update whose switch time is still ahead on this node's clock
        //is not built, as node-orchestrator config-manager.js skips it (`envelope.timestamp > Date.now()`). The clock only
        //decides to abstain and never reaches the payload; a timer that fires a millisecond early re-arms for the same
        //switch time
        if (updateTimeReached && !pendingConfig.allowEarlySubmission && pendingConfig.timestamp > Date.now())
            return false

        if (!updateTimeReached) { //if update time is not reached, check if all signatures are present
            //allowEarlySubmission is set by the orchestrator after the vote and is no more signed than timestamp is,
            //so it may skip the derived execution slot but never the floor the signers agreed to. Judged
            //on the tick, not the clock: a tick that fires late must not build what the orchestrator refuses for the
            //same tick. This must match node-orchestrator config-manager.js (`syncTimestamp < minDate`), and changing
            //it requires changing both sides in the same release
            const {minDate} = pendingConfig.config
            if (minDate && timestamp < minDate) {
                logger.debug({msg: 'Early submission is not allowed before the signed minDate', minDate})
                return false
            }
            if (!areAllSignaturesPresent(
                [...config.nodes.keys()],
                [...pendingConfig.config.nodes.keys()],
                pendingConfig.signatures
            ))
                return false
        }

        const {sorobanRpc, networkPassphrase} = settingsManager.getBlockchainConnectorSettings()
        //the system account read is bounded like every other runner's pre-build reads
        const sourceAccount = await withPreBuildDeadline(getAccount(config.systemAccount, sorobanRpc))

        //the builder writes nothing: a build abandoned by the deadline keeps running and finishes late, so anything it
        //wrote could overwrite what the transaction that actually landed said (the more-transactions flag)
        const updateTxBuilder = async (account, fee, maxTime) => await buildUpdateTransaction({
            timestamp: pendingConfig.timestamp,
            account,
            network: networkPassphrase,
            sorobanRpc,
            newConfig: pendingConfig.config,
            currentConfig: config,
            fee,
            maxTime
        })

        //this node's vote on the update being built, read before the round: a CONFIG message that arrives while the round
        //is in flight may clear the update or schedule another one, and the vote stored with the landed config must be
        //the one on the update that landed
        const ownVote = nonceManager.getNonce(nonceManager.nonceTypes.PENDING_CONFIG)

        //the tick is the sync timestamp, as node-orchestrator derives the hash from the tick it woke with
        const landed = await this.__buildAndSubmitTransaction(updateTxBuilder, sourceAccount, baseUpdateFee, timestamp)

        //a footprint restore that landed in place of the update is not the update (a restore never
        //counts as the requested transaction). Applying the config now would move this node to a config the chain has
        //not reached, so the pending config is kept and the next tick builds the real update. The flag is read where
        //runner-base reads it for __isRestoreSubstitution, on the same landed transaction, so the two cannot disagree.
        if (landed?.tx?.transaction?.isRestore) {
            logger.warn({msg: 'A footprint restore landed instead of the cluster update; the pending config is kept for the next tick', ...this.__contractInfo, hash: landed.tx.hashHex})
            return true
        }

        if (landed?.tx?.hasMoreTxns) //the transaction that landed says the config has more transactions to be submitted
            return true

        //the envelope and the base config this round was built from: the pending config can be cleared or replaced while
        //the round is in flight, and what landed is what the node must follow
        await settingsManager.applyPendingUpdate(ownVote, pendingConfig, config)
        return true
    }

    __getNextTimestamp(currentTimestamp) {
        const {pendingConfig} = container.settingsManager
        if (!pendingConfig || this.__pendingTransaction || pendingConfig.allowEarlySubmission || isPendingConfigExpired(pendingConfig))
            return normalizeTimestamp(currentTimestamp + idleWorkerTimeframe, idleWorkerTimeframe)
        return pendingConfig.timestamp
    }

    get __timeframe() {
        return idleWorkerTimeframe
    }
}

module.exports = ClusterRunner
//node-orchestrator domain/blockchain-data-provider.js derives the update hash with the same base fee
module.exports.baseUpdateFee = baseUpdateFee