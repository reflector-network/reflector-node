const {Config, buildUpdates} = require('@reflector/reflector-shared')

/**
 * @param {object} raw - raw cluster config
 * @returns {string} the hash nodes and the orchestrator compute
 */
function hashOf(raw) {
    return new Config(raw).getHash()
}

/**
 * @param {object} currentRaw - current config
 * @param {object} nextRaw - proposed config
 * @returns {Array<?string>} update types; null for a change applied without a transaction
 */
function updateTypes(currentRaw, nextRaw) {
    const updates = buildUpdates(1n, new Config(currentRaw), new Config(nextRaw))
    return [...updates.values()].map(update => (update ? update.type : null))
}

/**
 * @param {object} raw - raw config
 * @param {string} type - contract type
 * @param {string} [dataSource] - data source name
 * @returns {?object}
 */
function contractOf(raw, type, dataSource) {
    return Object.values(raw.contracts).find(c => c.type === type && (!dataSource || c.dataSource === dataSource)) || null
}

/**
 * @param {object} raw - raw config
 * @param {string} type - contract type
 * @returns {object[]}
 */
function contractsOfType(raw, type) {
    return Object.values(raw.contracts).filter(c => c.type === type)
}

function edit(raw, fn) {
    const next = structuredClone(raw)
    fn(next)
    const config = new Config(next)
    if (!config.isValid)
        throw new Error(`Invalid config: ${config.issuesString}`)
    return next
}

const toggle = (value, a, b) => (value === a ? b : a)

const mutations = {
    addNode: (raw, node) => edit(raw, c => {
        c.nodes[node.pubkey] = node
    }),
    removeNode: (raw, pubkey) => edit(raw, c => {
        delete c.nodes[pubkey]
    }),
    replaceNode: (raw, removedPubkey, node) => edit(raw, c => {
        delete c.nodes[removedPubkey]
        c.nodes[node.pubkey] = node
    }),
    setNodeUrl: (raw, pubkey, url) => edit(raw, c => {
        c.nodes[pubkey].url = url
    }),
    addAsset: (raw, contractId, asset) => edit(raw, c => {
        c.contracts[contractId].assets.push(asset)
    }),
    togglePeriod: (raw, id) => edit(raw, c => {
        c.contracts[id].period = toggle(c.contracts[id].period, 86400000, 172800000)
    }),
    toggleFeeConfig: (raw, id) => edit(raw, c => {
        const current = c.contracts[id].feeConfig
        if (!current)
            throw new Error(`Contract ${id} has no fee config to change`)
        c.contracts[id].feeConfig = {token: current.token, fee: toggle(current.fee, '100', '200')}
    }),
    toggleCacheSize: (raw, id) => edit(raw, c => {
        c.contracts[id].cacheSize = toggle(c.contracts[id].cacheSize, 5, 10)
    }),
    toggleSubscriptionFee: (raw, id) => edit(raw, c => {
        c.contracts[id].baseFee = toggle(c.contracts[id].baseFee, 1000, 2000)
    }),
    toggleDaoDeposits: (raw, id) => edit(raw, c => {
        const params = c.contracts[id].depositParams
        params['0'] = toggle(params['0'], '1000000000', '2000000000')
    }),
    setWasm: (raw, type, hash) => edit(raw, c => {
        const map = typeof c.wasmHash === 'string' ? {oracle: {hash: c.wasmHash, type: 'oracle'}} : {...c.wasmHash}
        map[type] = {hash, type}
        c.wasmHash = map
    }),
    addContract: (raw, contract) => edit(raw, c => {
        c.contracts[contract.contractId] = contract
    }),
    removeContract: (raw, id) => edit(raw, c => {
        delete c.contracts[id]
    }),
    toggleHeartbeat: raw => edit(raw, c => {
        c.priceHeartbeat = toggle(c.priceHeartbeat, 600000, 900000)
    }),
    toggleThreshold: (raw, id) => edit(raw, c => {
        const asset = c.contracts[id].assets[0]
        asset.threshold = toggle(asset.threshold, 1, 2)
    })
}

module.exports = {hashOf, updateTypes, contractOf, contractsOfType, mutations}
