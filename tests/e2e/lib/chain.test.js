/*eslint-disable no-undef */
const crypto = require('crypto')
const {Account, Keypair, StrKey, TransactionBuilder, Operation, nativeToScVal} = require('@stellar/stellar-sdk')
const {decodeTransaction, toJson} = require('./chain')

const passphrase = 'Test SDF Network ; September 2015'

describe('decodeTransaction', () => {
    const nodes = Array.from({length: 3}, () => Keypair.random())
    const system = Keypair.random().publicKey()
    const admin = Keypair.random().publicKey()
    const contract = StrKey.encodeContract(crypto.randomBytes(32))

    function build() {
        return new TransactionBuilder(new Account(system, '1'), {fee: '100', networkPassphrase: passphrase})
            .setTimeout(30)
            .addOperation(Operation.invokeContractFunction({contract, function: 'set_cache_size', args: [nativeToScVal(5, {type: 'u32'})]}))
            .addOperation(Operation.setOptions({source: admin, signer: {ed25519PublicKey: nodes[2].publicKey(), weight: 0}}))
            .addOperation(Operation.setOptions({lowThreshold: 2, medThreshold: 2, highThreshold: 2}))
            .build()
    }

    test('reads calls, signer changes and which known keys signed', () => {
        const tx = build()
        tx.sign(nodes[0], nodes[1])
        const decoded = decodeTransaction(tx.toXDR(), nodes.map(n => n.publicKey()))
        expect(decoded.source).toBe(system)
        expect(decoded.calls).toEqual([{contract, fn: 'set_cache_size'}])
        expect(decoded.setOptions[0]).toEqual({
            source: admin,
            signer: {pubkey: nodes[2].publicKey(), weight: 0},
            thresholds: {low: undefined, med: undefined, high: undefined}
        })
        expect(decoded.setOptions[1]).toEqual({source: system, signer: null, thresholds: {low: 2, med: 2, high: 2}})
        expect(decoded.signers).toEqual([nodes[0].publicKey(), nodes[1].publicKey()])
    })

    test('a signature by a key outside the known set does not count', () => {
        const tx = build()
        tx.sign(Keypair.random())
        expect(decodeTransaction(tx.toXDR(), nodes.map(n => n.publicKey())).signers).toEqual([])
    })
})

test('toJson writes BigInt values as strings', () => {
    expect(toJson({a: 5n, b: [1n]})).toBe('{"a":"5","b":["1"]}')
})
