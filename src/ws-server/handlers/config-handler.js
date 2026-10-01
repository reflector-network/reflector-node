const {ConfigEnvelope, hasMajority, getMajority} = require('@reflector/reflector-shared')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const logger = require('../../logger')
const nonceManager = require('../nonce-manager')
const BaseHandler = require('./base-handler')

/**
 * @typedef {import('@reflector/reflector-shared').ConfigEnvelope} ConfigEnvelope
 */

//How long past its switch time a held update may be dropped on an echo that does not verify. The runner builds
//an update at the first tick after its switch time and gives it a minute to land, so an update still held an hour
//later has failed on this node; a replayed clear can cancel nothing that could still run.
const staleClearDelay = 60 * 60 * 1000

/**
 * Public keys entitled to vote on an envelope: the CURRENT cluster's node set, not the envelope's own. A node the
 * proposal removes still votes on it; a node it adds must not. Before the first adoption the node has no cluster
 * config, so a current-config envelope is verified against its own node set - the bootstrap case, which carries no
 * weight on its own and is gated by isBootstrapAuthorized.
 * @param {ConfigEnvelope} envelope - envelope being verified
 * @param {boolean} allowBootstrap - true only for the current config
 * @returns {{allowed: string[], isBootstrap: boolean}} allowed signer public keys, empty when there is nothing to verify against
 */
function getAllowedSigners(envelope, allowBootstrap) {
    const currentNodes = container.settingsManager.config?.nodes
    if (currentNodes?.size)
        return {allowed: [...currentNodes.keys()], isBootstrap: false}
    if (!allowBootstrap)
        return {allowed: [], isBootstrap: false}
    return {allowed: [...envelope.config.nodes.keys()], isBootstrap: true}
}

/**
 * Whether the envelope is the config the operator pinned as clusterConfigHash in app.config.json. The operator is the
 * node's root of trust, so the pin alone authorises the first adoption: it needs no majority of the envelope's own node
 * set, which proves nothing at bootstrap, and a joining node could not meet one anyway when the change that admits it
 * was applied by a bare majority of the previous set - the only votes the orchestrator echoes.
 * @param {ConfigEnvelope} envelope - current config envelope
 * @returns {boolean} true when the envelope hash is the configured clusterConfigHash
 */
function isAnchored(envelope) {
    const {clusterConfigHash} = container.settingsManager.appConfig
    return !!clusterConfigHash && clusterConfigHash === envelope.config.getHash()
}

/**
 * Decides whether a first cluster config that the operator did not pin may be adopted. A node with no config has
 * nothing but the envelope to verify against, and the envelope declares its own node set, so a majority of that set is
 * satisfied by construction - anyone holding the orchestrator channel can mint one. Without the clusterConfigHash anchor
 * (isAnchored) the first config must therefore carry something the channel cannot produce: an accepting signature from
 * this node's own key. A node joining an existing cluster cannot have signed the config that admits it, so the anchor
 * is the route for that case; an operator who has already signed the live config in the dashboard needs neither.
 * @param {ConfigEnvelope} envelope - current config envelope
 * @param {string[]} accepted - public keys whose accepting signature verified
 * @returns {boolean} true when the first config may be adopted
 */
function isBootstrapAuthorized(envelope, accepted) {
    const {clusterConfigHash, publicKey} = container.settingsManager.appConfig
    const receivedHash = envelope.config.getHash()
    if (accepted.includes(publicKey))
        return true
    logger.error({
        msg: 'Refusing the first cluster config: it carries no accepting signature from this node and its hash is not '
            + 'the clusterConfigHash configured in app.config.json. Either sign the current cluster config in the admin '
            + 'dashboard, or set clusterConfigHash in app.config.json to the hash of the config this node must join and '
            + 'restart. Confirm that hash out of band before trusting it - the value below comes from the channel.',
        receivedHash,
        configuredHash: clusterConfigHash || null
    })
    return false
}

/**
 * Highest nonce among the signatures that counted toward the majority. Signature nonces are part of the signed
 * payload and the orchestrator burns them per signer, so a signer's next signature always carries a higher one
 * (node-orchestrator/domain/config-manager.js consumeSignatureNonce). A replayed superseded envelope therefore
 * carries only nonces the node has already moved past.
 * @param {ConfigEnvelope} envelope - envelope being verified
 * @param {string[]} accepted - public keys whose accepting signature verified
 * @returns {number} highest counted nonce, 0 when nothing counted
 */
function getHighestAcceptedNonce(envelope, accepted) {
    return envelope.signatures
        .filter(s => accepted.includes(s.pubkey))
        .reduce((highest, s) => Math.max(highest, s.nonce), 0)
}

/**
 * Lowest nonce among the signatures that counted toward the majority. Every vote on a config is cast after the config
 * before it was applied, because the orchestrator opens a proposal only once the previous one is settled, so a replayed
 * proposal carries no counted signature at or above this value. A replayed older config can: operators
 * who had not signed it may top it up at any time, also after the next proposal was signed. Those operators never make
 * up a majority of the set that applied it, which is why verifyConfig requires a majority of the current set at or
 * above this value, never a single signature. The highest counted nonce is no bound at all: a
 * top-up of the running config may be signed after the next proposal was, and a floor raised to it refuses that
 * proposal
 * @param {ConfigEnvelope} envelope - envelope being verified
 * @param {string[]} accepted - public keys whose accepting signature verified
 * @returns {number} lowest counted nonce, 0 when nothing counted
 */
function getLowestAcceptedNonce(envelope, accepted) {
    const nonces = envelope.signatures.filter(s => accepted.includes(s.pubkey)).map(s => s.nonce)
    return nonces.length ? Math.min(...nonces) : 0
}

/**
 * Counts the counted signatures made at or after the CONFIG floor - the earliest counted signature of the config this
 * node last adopted. A signature binds the config content, the signer, the nonce and the rejected flag, never the config
 * it replaces, so the config this node replaced is still a validly signed envelope, and one fresh signature on it - a
 * top-up by an operator who had not signed it - proves nothing. On the current config this node's own vote also counts
 * when it is newer than the CONFIG nonce this node stored: its operator's clock may lag the floor, while
 * a vote this node already stored with an earlier config is no new vote
 * @param {ConfigEnvelope} envelope - envelope being verified
 * @param {string[]} accepted - public keys whose accepting signature verified
 * @param {number} configFloor - the stored CONFIG floor
 * @param {object|null} ownVote - this node's own counted signature when it may count below the floor, otherwise null
 * @returns {number} how many counted signatures are fresh
 */
function countFreshSignatures(envelope, accepted, configFloor, ownVote) {
    return envelope.signatures.filter(s => accepted.includes(s.pubkey) && (s.nonce >= configFloor || s === ownVote)).length
}

/**
 * Verifies an envelope with the shared verifier and decides whether this node adopts it. Adoption needs a majority of
 * the current node set to have signed an acceptance; this node's own vote is not required, because the
 * orchestrator strips rejected signatures and a node that rejected an applied config could otherwise never adopt it.
 * Signatures that do not verify, and signers outside the current node set, are logged and ignored rather than treated
 * as a veto. At bootstrap a config pinned by clusterConfigHash needs no majority, and one that is not pinned must also
 * satisfy isBootstrapAuthorized. In every state the counted signatures must not all predate the stored nonce, and once
 * a config is held a majority of the current node set must have signed at or after the CONFIG floor (countFreshSignatures).
 * @param {ConfigEnvelope} configEnvelope - config envelope
 * @param {string} nonceType - nonce type from nonceManager.nonceTypes
 * @param {boolean} [allowBootstrap] - allow verification against the envelope's own node set when no config is loaded
 * @returns {{verified: boolean, nonce: number, lowestNonce: number}} nonce is the value to persist, or null to leave the
 * stored one alone; lowestNonce is the lowest nonce of the signatures that counted
 */
function verifyConfig(configEnvelope, nonceType, allowBootstrap = false) {
    const result = {verified: false, nonce: null, lowestNonce: 0}
    if (!configEnvelope.config.isValid) {
        logger.error({msg: 'Config is not valid. Issues:', issues: configEnvelope.config.issuesString})
        return result
    }
    const {allowed: allowedSigners, isBootstrap} = getAllowedSigners(configEnvelope, allowBootstrap)
    if (allowedSigners.length === 0) {
        logger.debug('No current node set to verify the config envelope against')
        return result
    }
    let verification = null
    try {
        verification = configEnvelope.verifySignatures(allowedSigners)
    } catch (err) {
        logger.error({err, msg: 'Failed to verify config envelope signatures'})
        return result
    }
    if (verification.invalid.length || verification.unknown.length)
        logger.warn({msg: 'Config envelope carries signatures that do not count', invalid: verification.invalid, unknown: verification.unknown})
    const anchored = isBootstrap && isAnchored(configEnvelope)
    if (isBootstrap && !anchored && !isBootstrapAuthorized(configEnvelope, verification.accepted))
        return result
    if (!anchored && !hasMajority(allowedSigners.length, verification.accepted.length)) {
        logger.warn({
            msg: 'Config envelope has no majority of the current node set',
            nonceType,
            hash: configEnvelope.config.getHash(),
            accepted: verification.accepted.length,
            required: getMajority(allowedSigners.length),
            nodes: allowedSigners.length
        })
        return result
    }
    const currentNonce = nonceManager.getNonce(nonceType)
    //a config every counted signer signed before the one this node already holds is a rollback, not an update. The
    //own-signature guard below covers it only when this node voted, which a node that abstained or was outvoted never
    //did, so the floor is applied to the highest counted nonce as well. For the current config the floor also rises on
    //every adoption; it is stored apart, so the own-signature guard keeps comparing this node's votes
    const floor = nonceType === nonceManager.nonceTypes.CONFIG
        ? Math.max(currentNonce, nonceManager.getNonce(nonceManager.nonceTypes.CONFIG_FLOOR))
        : currentNonce
    const highestNonce = getHighestAcceptedNonce(configEnvelope, verification.accepted)
    if (highestNonce < floor) {
        logger.error({msg: 'Config envelope is superseded: every counted signature predates the stored nonce', highestNonce, currentNonce: floor, nonceType})
        return result
    }
    const lowestNonce = getLowestAcceptedNonce(configEnvelope, verification.accepted)
    const {publicKey: currentPubkey} = container.settingsManager.appConfig
    //only a signature that verified may set this node's nonce: invalid entries are ignored rather than fatal, so an
    //unverified own-key entry is anyone's to write, and a huge nonce in it would refuse every later envelope.
    //The envelope holds at most one entry per key, so the accepted key identifies the entry that verified
    const ownSignature = verification.accepted.includes(currentPubkey)
        ? configEnvelope.signatures.find(s => s.pubkey === currentPubkey && !s.rejected)
        : null
    if (ownSignature && ownSignature.nonce < currentNonce) {
        logger.debug('Signature for current node is outdated')
        return result
    }
    //one counted signature at or after the floor is not enough: the config this node replaced, topped up after the
    //next one was signed by operators who had not signed it, carries such signatures, and a majority would schedule it
    //again as an update - an on-chain rollback - or adopt it again as the current config. Those operators are never a
    //majority of the set that applied it, and every honest envelope is signed after the config this node adopted, so a
    //majority of the current set must have signed at or after that config's earliest counted signature.
    //They can still be a majority of a smaller set that removed the config's other signers - per-signer
    //nonces would close that. At bootstrap there is no current set to count against
    const configFloor = nonceManager.getNonce(nonceManager.nonceTypes.CONFIG_FLOOR)
    if (!isBootstrap && configFloor) {
        const isCurrentConfig = nonceType === nonceManager.nonceTypes.CONFIG
        const ownVote = isCurrentConfig && ownSignature && ownSignature.nonce > currentNonce ? ownSignature : null
        const fresh = countFreshSignatures(configEnvelope, verification.accepted, configFloor, ownVote)
        if (!hasMajority(allowedSigners.length, fresh)) {
            logger.error({
                msg: 'Config envelope is superseded: fewer than a majority of the current node set signed after the config this node adopted',
                nonceType,
                fresh,
                required: getMajority(allowedSigners.length),
                configFloor
            })
            return result
        }
    }
    if (ownSignature) {
        //the CONFIG nonce stored for an adopted config is its lowest counted nonce, never this node's own signature
        //above it: the own signature can be a top-up signed after the next proposal was, and as the CONFIG nonce it
        //would refuse that proposal once it lands, as outdated and as superseded. It is never
        //lowered either. A pending update keeps this node's own vote, which the cluster runner stores once it lands
        result.nonce = nonceType === nonceManager.nonceTypes.CONFIG
            ? Math.max(currentNonce, Math.min(ownSignature.nonce, lowestNonce))
            : ownSignature.nonce
    }
    result.lowestNonce = lowestNonce
    result.verified = true
    return result
}

/**
 * The orchestrator sets the execution time after the vote and it is not covered by the signatures, so the
 * node refuses a schedule that precedes the signed minDate. A minDate of 0 means the proposal fixed no execution time
 * at all, so the orchestrator derives one from its own clock and there is nothing signed to compare against; when the
 * proposal did fix an explicit execution time, minDate carries that same value and the check holds with equality.
 * @param {ConfigEnvelope} envelope - pending config envelope
 * @returns {boolean} true when the schedule is within what the signers agreed to
 */
function isScheduledAfterMinDate(envelope) {
    const {minDate} = envelope.config
    if (!minDate)
        return true
    return envelope.timestamp >= minDate
}

/**
 * A scheduled update identical to the config this node already runs has nothing left to apply. It is dropped whatever
 * the message carries: it happens when the current config was adopted from the orchestrator's echo rather than by the
 * cluster runner, and holding it would refuse every later proposal (setPendingConfig keeps one update at a time).
 * @param {object} settingsManager - settings manager
 */
function dropAppliedPendingConfig(settingsManager) {
    const {config, pendingConfig} = settingsManager
    if (!config || !pendingConfig || pendingConfig.config.getHash() !== config.getHash())
        return
    logger.info({msg: 'Dropping the scheduled update: this node already runs that config', hash: config.getHash()})
    settingsManager.clearPendingConfig()
}

class ConfigHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.ORCHESTRATOR]

    allowAnonymous = true

    async handle(_, message) {
        if (!message.data)
            throw new Error('Data is required')
        const {currentConfig, pendingConfig} = message.data
        if (!currentConfig) //if no current config, then no updates
            return

        const {settingsManager} = container
        dropAppliedPendingConfig(settingsManager)

        let newCurrentConfig = null
        try {
            //7.2.0 validates signature entries in the constructor: a malformed one throws ValidationError here, where
            //7.1.4 stored it unchecked. A malformed config field does not throw - it lands in config.issues instead
            //and is caught by the isValid check in verifyConfig
            newCurrentConfig = new ConfigEnvelope(currentConfig)
        } catch (err) {
            logger.error({err, msg: 'Malformed current config envelope'})
            return
        }
        const heldHash = settingsManager.config?.getHash() || null
        const receivedHash = newCurrentConfig.config.getHash()
        const isAlreadyApplied = heldHash === receivedHash
        //verified even when already applied: the pending clear below is authorised by exactly this result. In steady
        //state the orchestrator echoes the config this node just applied, so skipping verification here would mean the
        //clear normally runs with no signature check at all.
        const configVerificationResult = verifyConfig(newCurrentConfig, nonceManager.nonceTypes.CONFIG, true)
        if (!configVerificationResult.verified && !isAlreadyApplied) {
            logger.warn({msg: 'Refusing the current config', receivedHash, heldHash})
            return //an unverified message must not touch the scheduled update either
        }
        //an echo of the config this node already runs may fail verification for good: the orchestrator echoes the votes
        //cast by the node set the change was voted on, and after a node-set change applied by a bare majority of that
        //set they are no majority of the set now held. The pending envelope below carries its own majority check
        //against the current set, so it is still verified on its own - only the clear stays gated on the echo
        if (!isAlreadyApplied) {
            try {
                //a proposal signed before the config this node now runs is a replay, whether or not this node voted,
                //and so is a config signed before it. Both floors are the lowest counted nonce: a top-up
                //signed after the next proposal must not lift them past it. The floors are stored
                //before setConfig writes the config: nothing on disk would raise them again if the process stopped
                //between the two, while floors raised for a config that then fails to apply refuse only what a majority
                //of the current set signed before it
                settingsManager.raisePendingConfigFloor(configVerificationResult.lowestNonce)
                settingsManager.raiseConfigFloor(configVerificationResult.lowestNonce)
                //setConfig refuses a validator-set replacement that breaks continuity with the current one, so it can
                //throw on a verified envelope; a failed adoption must leave the scheduled update alone
                await settingsManager.setConfig(newCurrentConfig.config, configVerificationResult.nonce)
            } catch (err) {
                logger.error({err, msg: 'Failed to apply the current config'})
                return
            }
        }

        if (pendingConfig) {
            let newPendingConfig = null
            try {
                newPendingConfig = new ConfigEnvelope(pendingConfig)
            } catch (err) {
                logger.error({err, msg: 'Malformed pending config envelope'})
                return
            }
            if (!isScheduledAfterMinDate(newPendingConfig)) {
                logger.warn({msg: 'Pending config is scheduled before its signed minDate', timestamp: newPendingConfig.timestamp, minDate: newPendingConfig.config.minDate})
                return
            }
            const pendingConfigVerificationResult = verifyConfig(newPendingConfig, nonceManager.nonceTypes.PENDING_CONFIG)
            if (pendingConfigVerificationResult.verified) {
                try {
                    //setPendingConfig throws when an update is already scheduled or when the envelope carries no
                    //change at all; contained here so one bad frame cannot take the handler down. The expiration date
                    //travels beside the envelope, outside every signature, and ConfigEnvelope drops it: it is handed
                    //on raw, and setPendingConfig keeps it only if it is a usable date
                    const {nonce} = pendingConfigVerificationResult
                    settingsManager.setPendingConfig(newPendingConfig, nonce, true, pendingConfig.expirationDate)
                } catch (err) {
                    logger.error({err, msg: 'Failed to schedule the pending config'})
                }
            } else {
                logger.debug('Pending config is not verified')
            }
        } else if (settingsManager.pendingConfig) {
            //the orchestrator signals a cancelled or expired update by omitting pendingConfig from a CONFIG message;
            //only a message whose current config verified is allowed to drop the scheduled update
            if (!configVerificationResult.verified) {
                const {timestamp} = settingsManager.pendingConfig
                const hash = settingsManager.pendingConfig.config.getHash()
                //An echo of the running config stops verifying for good after a node-set change applied by a bare
                //majority of the old set, so a rejected update would otherwise be held - and retried, and block every
                //later proposal - until operators add signatures. Dropping it is liveness only: it adopts nothing, and
                //an honest orchestrator re-sends an update that is still PENDING on its next CONFIG message. The local
                //clock is fine here because nothing it decides reaches a transaction payload
                if (isAlreadyApplied && Date.now() > timestamp + staleClearDelay) {
                    logger.warn({msg: 'Orchestrator reports no pending config and the scheduled update is an hour past its switch time; clearing it although the current config echo does not verify', hash, timestamp})
                    settingsManager.clearPendingConfig()
                    return
                }
                logger.warn({
                    msg: 'Orchestrator reports no pending config, but the current config echo does not verify; keeping the scheduled update',
                    hash,
                    timestamp
                })
                return
            }
            logger.info({msg: 'Orchestrator reports no pending config, clearing the scheduled update', hash: settingsManager.pendingConfig.config.getHash()})
            settingsManager.clearPendingConfig()
        }
    }
}

module.exports = ConfigHandler
