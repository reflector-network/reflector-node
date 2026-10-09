/*eslint-disable no-undef */
const {Keypair, xdr} = require('@stellar/stellar-sdk')
const ChannelTypes = require('../../../src/ws-server/channels/channel-types')

const mockRunner = {addSignature: jest.fn()}
jest.mock('../../../src/domain/runners/runner-manager', () => ({
    has: jest.fn(() => true),
    get: jest.fn(() => mockRunner),
    updatesRunner: mockRunner
}))

const runnerManager = require('../../../src/domain/runners/runner-manager')
const SignaturesHandler = require('../../../src/ws-server/handlers/signatures-handler')

const peer = Keypair.random()
const other = Keypair.random()
const contractId = 'C'.repeat(56)
const hash = Buffer.alloc(32, 0xab) //0xab so the hex has letters and toUpperCase() actually differs
const hashHex = hash.toString('hex')
const otherHash = Buffer.alloc(32, 9)

/**
 * @param {Keypair} signer - keypair that produced the signature
 * @param {Buffer} [payload] - transaction hash the signature was made over, the frame hash by default
 * @returns {string} hex-encoded decorated signature, as a SIGNATURE frame carries it
 */
function signatureHex(signer, payload = hash) {
    return signer.signDecorated(payload).toXDR('hex')
}

/**
 * Builds a frame carrying the signer's own genuine signature bytes under a hint that is not the signer's, which a
 * count by hint would take for a signature from a second, distinct signer.
 * @param {Keypair} signer - keypair that produced the signature bytes
 * @param {Buffer} hint - four-byte signature hint presented instead of the signer's own
 * @returns {string} hex-encoded decorated signature with a fabricated hint
 */
function forgedHintHex(signer, hint) {
    return new xdr.DecoratedSignature({hint, signature: signer.signDecorated(hash).signature}).toXDR('hex')
}

describe('SignaturesHandler', () => {
    let handler

    beforeEach(() => {
        jest.clearAllMocks()
        runnerManager.has.mockReturnValue(true)
        runnerManager.get.mockReturnValue(mockRunner)
        handler = new SignaturesHandler()
    })

    test('declares its channel policy explicitly', () => {
        expect(handler.allowedChannelTypes).toEqual([ChannelTypes.OUTGOING, ChannelTypes.INCOMING])
        expect(handler.allowAnonymous).toBe(false)
    })

    test('forwards a signature the sending peer produced itself', () => {
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex, signature: signatureHex(peer)}})

        expect(mockRunner.addSignature).toHaveBeenCalledTimes(1)
        const [forwardedHash, forwardedSignature, from] = mockRunner.addSignature.mock.calls[0]
        expect(forwardedHash).toBe(hashHex)
        expect(from).toBe(peer.publicKey())
        expect(forwardedSignature.hint.equals(new xdr.SignatureHint(peer.signatureHint()))).toBe(true)
    })

    test('refuses a signature whose hint is not the sending peer own hint', () => {
        //the peer own genuine signature bytes under a fabricated hint - keypair.verify() accepts these, so the hint
        //comparison is the only guard that refuses them
        const forgedPeerHint = forgedHintHex(peer, other.signatureHint())
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex, signature: forgedPeerHint}})
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex, signature: forgedHintHex(peer, Buffer.alloc(4, 1))}})
        //a relayed signature another node produced, hint and bytes both belonging to that node
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex, signature: signatureHex(other)}})

        expect(mockRunner.addSignature).not.toHaveBeenCalled()
    })

    test('refuses a signature the sending peer made over a different transaction hash', () => {
        //the peer own hint, so the hint comparison passes and only keypair.verify() refuses the cross-transaction replay
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex, signature: signatureHex(peer, otherHash)}})

        expect(mockRunner.addSignature).not.toHaveBeenCalled()
    })

    test('ignores a hash that is not 64 lowercase hex even when it decodes to the signed bytes', () => {
        //Buffer.from() accepts uppercase hex and drops a trailing half-byte, so both of these verify against the
        //signature and only the hash shape guard refuses them
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex.toUpperCase(), signature: signatureHex(peer)}})
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex + 'a', signature: signatureHex(peer)}})
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: '__proto__', signature: signatureHex(peer)}})
        handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: 'ZZ'.repeat(32), signature: signatureHex(peer)}})

        expect(mockRunner.addSignature).not.toHaveBeenCalled()
    })

    test('ignores a non-string hash or signature without throwing', () => {
        //RegExp.test() stringifies its argument, so a non-string hash passes the shape guard and then throws in
        //Buffer.from(); Buffer.from() ignores the encoding for an array, so a byte array parses as a valid signature
        const stringifiesToHash = {toString: () => hashHex}
        const signatureBytes = [...Buffer.from(signatureHex(peer), 'hex')]
        const nonStringHash = {data: {contractId, hash: stringifiesToHash, signature: signatureHex(peer)}}
        const nonStringSignature = {data: {contractId, hash: hashHex, signature: signatureBytes}}
        expect(() => handler.handle({pubkey: peer.publicKey()}, nonStringHash)).not.toThrow()
        expect(() => handler.handle({pubkey: peer.publicKey()}, nonStringSignature)).not.toThrow()

        expect(mockRunner.addSignature).not.toHaveBeenCalled()
    })

    test('ignores a malformed signature payload without throwing', () => {
        expect(() => handler.handle({pubkey: peer.publicKey()}, {data: {contractId, hash: hashHex, signature: 'not-xdr'}})).not.toThrow()
        expect(mockRunner.addSignature).not.toHaveBeenCalled()
    })

    test('ignores a frame with no usable data payload without throwing', () => {
        expect(() => handler.handle({pubkey: peer.publicKey()}, {})).not.toThrow()
        expect(() => handler.handle({pubkey: peer.publicKey()}, {data: null})).not.toThrow()
        expect(() => handler.handle({pubkey: peer.publicKey()}, {data: {}})).not.toThrow()

        expect(mockRunner.addSignature).not.toHaveBeenCalled()
    })

    test('a contract this node does not run is ignored rather than throwing', () => {
        runnerManager.has.mockReturnValue(false)

        const frame = {data: {contractId, hash: hashHex, signature: signatureHex(peer)}}
        expect(() => handler.handle({pubkey: peer.publicKey()}, frame)).not.toThrow()
        expect(runnerManager.get).not.toHaveBeenCalled()
        expect(mockRunner.addSignature).not.toHaveBeenCalled()
    })

    test('a frame without a contract id goes to the cluster runner', () => {
        handler.handle({pubkey: peer.publicKey()}, {data: {hash: hashHex, signature: signatureHex(peer)}})

        expect(mockRunner.addSignature).toHaveBeenCalledTimes(1)
    })
})
