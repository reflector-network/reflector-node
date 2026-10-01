/*eslint-disable no-undef */
jest.unmock('../src/logger')

let cleanup

beforeAll(() => {
    const logger = require('../src/logger')
    cleanup = logger.__cleanup
})

describe('logger cleanup', () => {

    it('should not mutate the original object', () => {
        const original = {message: 'test', ip: '192.168.1.100'}
        const originalSnapshot = JSON.stringify(original)
        cleanup(original)
        expect(JSON.stringify(original)).toBe(originalSnapshot)
    })

    it('should not mutate nested objects', () => {
        const inner = {addr: '10.0.0.1'}
        const original = {data: inner}
        cleanup(original)
        expect(inner.addr).toBe('10.0.0.1')
    })

    it('should not mutate arrays', () => {
        const original = ['192.168.1.1', 'hello']
        cleanup(original)
        expect(original[0]).toBe('192.168.1.1')
        expect(original[1]).toBe('hello')
    })

    it('should sanitize IP addresses in strings', () => {
        const result = cleanup('connected to 192.168.1.100')
        expect(result).toBe('connected to 192.***.***.100')
    })

    it('should sanitize IPs in object values', () => {
        const result = cleanup({host: '10.0.0.1'})
        expect(result.host).toBe('10.***.***.1')
    })

    it('should sanitize IPs in nested objects', () => {
        const result = cleanup({outer: {inner: '172.16.0.5'}})
        expect(result.outer.inner).toBe('172.***.***.5')
    })

    it('should sanitize IPs in arrays', () => {
        const result = cleanup(['10.0.0.1', '192.168.1.1'])
        expect(result[0]).toBe('10.***.***.1')
        expect(result[1]).toBe('192.***.***.1')
    })

    it('should handle circular references', () => {
        const obj = {name: 'test'}
        obj.self = obj
        const result = cleanup(obj)
        expect(result.name).toBe('test')
        expect(result.self).toBe('[Circular]')
    })

    it('should handle deeply nested circular references', () => {
        const a = {name: 'a'}
        const b = {name: 'b', parent: a}
        a.child = b
        const result = cleanup(a)
        expect(result.name).toBe('a')
        expect(result.child.name).toBe('b')
        expect(result.child.parent).toBe('[Circular]')
    })

    it('should pass through non-string primitives unchanged', () => {
        expect(cleanup(42)).toBe(42)
        expect(cleanup(true)).toBe(true)
        expect(cleanup(null)).toBe(null)
        expect(cleanup(undefined)).toBe(undefined)
    })

    it('should replace backslashes with forward slashes in strings', () => {
        const result = cleanup('some\\path\\here')
        expect(result).toBe('some/path/here')
    })

    it('should handle mixed nested structures', () => {
        const original = {
            users: [
                {name: 'alice', ip: '10.0.0.1'},
                {name: 'bob', ip: '172.16.0.5'}
            ],
            count: 2
        }
        const result = cleanup(original)
        expect(result.users[0].ip).toBe('10.***.***.1')
        expect(result.users[1].ip).toBe('172.***.***.5')
        expect(result.count).toBe(2)
        //originals untouched
        expect(original.users[0].ip).toBe('10.0.0.1')
        expect(original.users[1].ip).toBe('172.16.0.5')
    })

    it('should handle empty objects and arrays', () => {
        expect(cleanup({})).toEqual({})
        expect(cleanup([])).toEqual([])
    })

    it('masks a stellar secret seed and keeps a public key', () => {
        const {Keypair} = require('@stellar/stellar-sdk')
        const kp = Keypair.random()
        const result = cleanup(`seed ${kp.secret()} of ${kp.publicKey()}`)
        expect(result).not.toContain(kp.secret())
        expect(result).toContain(kp.publicKey())
    })

    it('masks rsa key material, in PEM and in the base64 DER form clusterSecret uses', () => {
        const {privateKey} = require('crypto').generateKeyPairSync('rsa', {modulusLength: 2048})
        const der = privateKey.export({type: 'pkcs8', format: 'der'}).toString('base64')
        const pem = privateKey.export({type: 'pkcs8', format: 'pem'}).trim()
        expect(cleanup(`secret ${der} end`)).toBe('secret [redacted] end')
        expect(cleanup(`secret ${pem} end`)).toBe('secret [redacted] end')
    })

    it('masks credentials, api keys in a query string and the body of an ipv6 address', () => {
        expect(cleanup('authorization: Bearer abc.def-ghi')).toBe('authorization: [redacted]')
        //a url loses its path and query altogether; a query string on its own keeps what is not a key
        expect(cleanup('GET https://api.example.com/v1?apiKey=SUPERSECRET&symbol=BTC failed')).toBe('GET https://api.example.com failed')
        const query = cleanup('query ?apiKey=SUPERSECRET&symbol=BTC&access_key=SECRET2&key=SECRET3')
        expect(query).toBe('query ?apiKey=[redacted]&symbol=BTC&access_key=[redacted]&key=[redacted]')
        const ipv6 = cleanup('peer 2001:db8:85a3::8a2e:370:7334 connected')
        expect(ipv6).toContain('2001:***:7334')
        expect(ipv6).not.toContain('85a3')
    })
})
