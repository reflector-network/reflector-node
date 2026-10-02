const {createHash} = require('crypto')
const {rpc, xdr, Account, Address, Keypair, Operation, TransactionBuilder, FeeBumpTransaction, scValToNative} = require('@stellar/stellar-sdk')
const {getContractState, getContractInstance, getNativeStorage} = require('@reflector/reflector-shared')
const {settings} = require('./env')

const server = () => new rpc.Server(settings.sorobanRpc[0])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {any} value - value that may hold BigInt
 * @returns {string}
 */
function toJson(value) {
    return JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? v.toString() : v))
}

async function horizon(pathname) {
    const res = await fetch(settings.horizonUrl + pathname)
    if (!res.ok)
        throw new Error(`Horizon ${pathname} failed with ${res.status}`)
    return res.json()
}

//SDK 17 decodes XDR into plain objects where earlier versions had accessor methods; read either form
function field(value, name) {
    return typeof value[name] === 'function' ? value[name]() : value[name]
}

function bytes(value) {
    return Buffer.from(value.value || value.bytes || value)
}

function invocationOf(func) {
    const type = typeof func.switch === 'function' ? func.switch().name : func.type
    if (type !== 'hostFunctionTypeInvokeContract')
        return null
    const invoke = field(func, 'invokeContract')
    const name = field(invoke, 'functionName')
    return {
        contract: Address.fromScAddress(field(invoke, 'contractAddress')).toString(),
        fn: bytes(name).toString()
    }
}

/**
 * @param {string} envelopeXdr - transaction envelope, base64
 * @param {string[]} knownPubkeys - keys to look for among the signatures
 * @returns {{source: string, calls: object[], setOptions: object[], signers: string[]}}
 */
function decodeTransaction(envelopeXdr, knownPubkeys = []) {
    let tx = TransactionBuilder.fromXDR(envelopeXdr, settings.passphrase)
    if (tx instanceof FeeBumpTransaction)
        tx = tx.innerTransaction
    const calls = []
    const setOptions = []
    for (const op of tx.operations) {
        if (op.type === 'invokeHostFunction') {
            const call = invocationOf(op.func)
            if (call)
                calls.push(call)
        } else if (op.type === 'setOptions') {
            setOptions.push({
                source: op.source || tx.source,
                signer: op.signer ? {pubkey: op.signer.ed25519PublicKey, weight: op.signer.weight} : null,
                thresholds: {low: op.lowThreshold, med: op.medThreshold, high: op.highThreshold}
            })
        }
    }
    const txHash = tx.hash()
    const signers = knownPubkeys.filter(pubkey => {
        const keypair = Keypair.fromPublicKey(pubkey)
        const hint = Buffer.from(keypair.signatureHint())
        return tx.signatures.some(s => hint.equals(bytes(field(s, 'hint'))) && keypair.verify(txHash, bytes(field(s, 'signature'))))
    })
    return {source: tx.source, calls, setOptions, signers}
}

/**
 * @param {string} accountId - account
 * @returns {Promise<{signers: object, thresholds: {low: number, med: number, high: number}}>}
 */
async function accountSigners(accountId) {
    const account = await horizon(`/accounts/${accountId}`)
    const signers = {}
    for (const signer of account.signers)
        if (signer.type === 'ed25519_public_key' && signer.weight > 0)
            signers[signer.key] = signer.weight
    const {low_threshold: low, med_threshold: med, high_threshold: high} = account.thresholds
    return {signers, thresholds: {low, med, high}}
}

function fromRecord(record, knownPubkeys) {
    return {
        hash: record.hash,
        successful: record.successful,
        time: Date.parse(record.created_at),
        ...decodeTransaction(record.envelope_xdr, knownPubkeys)
    }
}

async function getTransaction(hash, knownPubkeys = []) {
    return fromRecord(await horizon(`/transactions/${hash}`), knownPubkeys)
}

async function recentTransactions(accountId, {since = 0, limit = 100, knownPubkeys = []} = {}) {
    const page = await horizon(`/accounts/${accountId}/transactions?order=desc&limit=${limit}`)
    return page._embedded.records
        .filter(record => Date.parse(record.created_at) >= since)
        .map(record => fromRecord(record, knownPubkeys))
}

async function contractState(contractId) {
    const state = await getContractState(contractId, settings.sorobanRpc)
    return {...state, lastTimestamp: Number(state.lastTimestamp)}
}

/**
 * @param {string} contractId - contract
 * @returns {Promise<?object>} every instance storage entry, native
 */
async function instanceStorage(contractId) {
    const instance = await getContractInstance(contractId, settings.sorobanRpc)
    if (!instance)
        return null
    const keys = (instance.storage || []).map(entry => scValToNative(entry.key))
    return getNativeStorage(instance.storage, keys)
}

/**
 * Read-only call through simulation
 * @param {string} contractId - contract
 * @param {string} fn - function name
 * @param {xdr.ScVal[]} args - arguments
 * @param {string} sourceAccount - any existing account
 * @returns {Promise<any>} native return value
 */
async function simulate(contractId, fn, args, sourceAccount) {
    const rpcServer = server()
    const account = await rpcServer.getAccount(sourceAccount)
    const source = new Account(account.accountId(), account.sequenceNumber())
    const tx = new TransactionBuilder(source, {fee: '100', networkPassphrase: settings.passphrase})
        .setTimeout(30)
        .addOperation(Operation.invokeContractFunction({contract: contractId, function: fn, args}))
        .build()
    const result = await rpcServer.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(result))
        throw new Error(`Simulation of ${fn} failed: ${result.error}`)
    return scValToNative(result.result.retval)
}

async function fundAccount(pubkey) {
    const res = await fetch(`${settings.friendbotUrl}?addr=${pubkey}`)
    if (!res.ok && res.status !== 400)
        throw new Error(`Friendbot failed with ${res.status}`)
}

async function wasmExists(hash) {
    const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash: Buffer.from(hash, 'hex')}))
    const result = await server().getLedgerEntries(key)
    return (result.entries || []).length > 0
}

/**
 * @param {Keypair} keypair - funded account paying for the upload
 * @param {Buffer} wasm - contract binary
 * @returns {Promise<string>} the code hash
 */
async function uploadWasm(keypair, wasm) {
    const rpcServer = server()
    const account = await rpcServer.getAccount(keypair.publicKey())
    let tx = new TransactionBuilder(account, {fee: '1000000', networkPassphrase: settings.passphrase})
        .setTimeout(60)
        .addOperation(Operation.uploadContractWasm({wasm}))
        .build()
    tx = await rpcServer.prepareTransaction(tx)
    tx.sign(keypair)
    const sent = await rpcServer.sendTransaction(tx)
    let result = await rpcServer.getTransaction(sent.hash)
    while (result.status === 'NOT_FOUND') {
        await sleep(1000)
        result = await rpcServer.getTransaction(sent.hash)
    }
    if (result.status !== 'SUCCESS')
        throw new Error(`Wasm upload failed: ${result.status}`)
    return createHash('sha256').update(wasm).digest('hex')
}

module.exports = {
    toJson,
    decodeTransaction,
    accountSigners,
    getTransaction,
    recentTransactions,
    contractState,
    instanceStorage,
    simulate,
    fundAccount,
    wasmExists,
    uploadWasm
}
