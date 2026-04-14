/*eslint-disable no-undef */
const {validateWebhookUrl, resolveAndValidate, isPrivateIP} = require('../../src/utils/ssrf-validator')

describe('ssrf-validator', () => {

    describe('isPrivateIP', () => {
        const privateCases = [
            '127.0.0.1',
            '127.255.255.255',
            '10.0.0.1',
            '10.255.255.255',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.0.1',
            '192.168.255.255',
            '169.254.169.254',
            '0.0.0.0',
            '::1',
            '::',
            'fe80::1',
            'fc00::1',
            'fd00::1',
            '::ffff:127.0.0.1',
            '::ffff:10.0.0.1',
            '::ffff:169.254.169.254'
        ]

        for (const ip of privateCases) {
            it(`blocks private IP ${ip}`, () => {
                expect(isPrivateIP(ip)).toBe(true)
            })
        }

        const publicCases = [
            '8.8.8.8',
            '1.1.1.1',
            '172.32.0.1',
            '172.15.255.255',
            '192.167.0.1',
            '169.253.0.1',
            '200.100.50.25'
        ]

        for (const ip of publicCases) {
            it(`allows public IP ${ip}`, () => {
                expect(isPrivateIP(ip)).toBe(false)
            })
        }
    })

    describe('validateWebhookUrl', () => {
        it('accepts http URLs', () => {
            const result = validateWebhookUrl('http://example.com/hook')
            expect(result.hostname).toBe('example.com')
        })

        it('accepts https URLs', () => {
            const result = validateWebhookUrl('https://example.com/hook')
            expect(result.hostname).toBe('example.com')
        })

        it('rejects ftp scheme', () => {
            expect(() => validateWebhookUrl('ftp://example.com')).toThrow('Blocked URL scheme')
        })

        it('rejects file scheme', () => {
            expect(() => validateWebhookUrl('file:///etc/passwd')).toThrow('Blocked URL scheme')
        })

        it('rejects malformed URLs', () => {
            expect(() => validateWebhookUrl('not-a-url')).toThrow()
        })
    })

    describe('resolveAndValidate', () => {
        it('blocks localhost IP', async () => {
            await expect(resolveAndValidate('http://127.0.0.1/hook')).rejects.toThrow('SSRF blocked')
        })

        it('blocks private 10.x IP', async () => {
            await expect(resolveAndValidate('http://10.0.0.1/hook')).rejects.toThrow('SSRF blocked')
        })

        it('blocks 192.168.x IP', async () => {
            await expect(resolveAndValidate('http://192.168.1.1/hook')).rejects.toThrow('SSRF blocked')
        })

        it('blocks cloud metadata IP', async () => {
            await expect(resolveAndValidate('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('SSRF blocked')
        })

        it('blocks 0.0.0.0', async () => {
            await expect(resolveAndValidate('http://0.0.0.0/')).rejects.toThrow('SSRF blocked')
        })

        it('rejects non-http scheme', async () => {
            await expect(resolveAndValidate('ftp://example.com')).rejects.toThrow('Blocked URL scheme')
        })

        it('allows public IP', async () => {
            const result = await resolveAndValidate('http://8.8.8.8/hook')
            expect(result.resolvedIp).toBe('8.8.8.8')
        })
    })
})
