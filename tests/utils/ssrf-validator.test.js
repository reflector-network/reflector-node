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

    describe('resolveAndValidate address families', () => {
        const blocked = [
            'http://[::1]/hook',
            'http://[0:0:0:0:0:0:0:1]/hook',
            'http://[fe80::1]/hook',
            'http://[::ffff:127.0.0.1]:6379/',
            'http://[::ffff:7f00:1]/',
            'http://[0:0:0:0:0:ffff:7f00:1]/',
            'http://[::ffff:169.254.169.254]/latest/meta-data/',
            'http://[::ffff:10.0.0.1]/',
            'http://[2002:7f00:1::]/',
            'http://[64:ff9b::7f00:1]/',
            'http://[::127.0.0.1]/',
            'http://100.64.0.1/',
            'http://100.127.255.254/',
            'http://198.18.0.1/',
            'http://224.0.0.1/',
            'http://255.255.255.255/'
        ]
        for (const url of blocked)
            it(`refuses ${url}`, async () => {
                await expect(resolveAndValidate(url)).rejects.toThrow('SSRF blocked')
            })

        const allowed = [
            ['http://172.15.0.1/', '172.15.0.1'],
            ['http://172.32.0.1/', '172.32.0.1'],
            ['http://[2001:4860:4860::8888]/hook', '2001:4860:4860::8888']
        ]
        for (const [url, ip] of allowed)
            it(`still allows ${url}`, async () => {
                expect((await resolveAndValidate(url)).resolvedIp).toBe(ip)
            })

        it('sets a safe message on every rejection, including a bare parse failure', async () => {
            for (const url of ['not a url', '', 'http://', 'file:///etc/passwd', 'ftp://example.com'])
                await expect(resolveAndValidate(url)).rejects.toMatchObject({safeMessage: expect.any(String)})
        })

        it('unbracketHost leaves a plain hostname alone', () => {
            const {unbracketHost} = require('../../src/utils/ssrf-validator')
            expect(unbracketHost('example.com')).toBe('example.com')
            expect(unbracketHost('[::1]')).toBe('::1')
        })
    })

    describe('address families beyond the common forms', () => {
        //the literal never reaches the resolver once it is unbracketed, so these hold on every platform
        const blocked = [
            ['http://[ff02::1]/', 'ff02::1'], //multicast
            ['http://[febf::1]/', 'febf::1'], //top of fe80::/10
            ['http://[fd12::1]/', 'fd12::1'], //unique local
            ['http://[::]/', '::'],
            ['http://[::ffff:100.64.0.1]/', '::ffff:6440:1'], //mapped carrier-grade NAT
            ['http://[::ffff:192.168.1.1]/', '::ffff:c0a8:101'],
            ['http://[2002:a9fe:a9fe::]/', '2002:a9fe:a9fe::'], //6to4 wrapping the metadata address
            ['http://[64:ff9b::a9fe:a9fe]/', '64:ff9b::a9fe:a9fe'], //NAT64 wrapping the metadata address
            ['http://[::a9fe:a9fe]/', '::a9fe:a9fe'], //IPv4-compatible wrapping the metadata address
            ['http://192.0.0.1/', '192.0.0.1'],
            ['http://192.0.2.1/', '192.0.2.1'],
            ['http://198.51.100.1/', '198.51.100.1'],
            ['http://203.0.113.1/', '203.0.113.1'],
            ['http://240.0.0.1/', '240.0.0.1']
        ]
        for (const [url, host] of blocked)
            it(`refuses ${url} as ${host}`, async () => {
                expect(new URL(url).hostname).toBe(host.includes(':') ? `[${host}]` : host)
                await expect(resolveAndValidate(url)).rejects.toMatchObject({
                    message: expect.stringContaining('SSRF blocked'),
                    safeMessage: 'Host resolves to a private address'
                })
            })

        const allowed = [
            ['http://[::ffff:8.8.8.8]/', '::ffff:808:808'],
            ['http://[2002:808:808::]/', '2002:808:808::'],
            ['http://[64:ff9b::808:808]/', '64:ff9b::808:808'],
            ['http://100.63.255.255/', '100.63.255.255'],
            ['http://100.128.0.1/', '100.128.0.1'],
            ['http://198.17.255.255/', '198.17.255.255'],
            ['http://198.20.0.1/', '198.20.0.1'],
            ['http://223.255.255.255/', '223.255.255.255']
        ]
        for (const [url, ip] of allowed)
            it(`still allows ${url}`, async () => {
                expect((await resolveAndValidate(url)).resolvedIp).toBe(ip)
            })

        it('decides an IPv6 address on its bytes, not on its spelling', () => {
            const {toIPv6Bytes} = require('../../src/utils/ssrf-validator')
            const loopbackMapped = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]
            for (const spelling of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::FFFF:7F00:0001'])
                expect(toIPv6Bytes(spelling)).toEqual(loopbackMapped)
            expect(toIPv6Bytes('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
            expect(toIPv6Bytes('1::2::3')).toBe(null)
            expect(toIPv6Bytes('1:2:3')).toBe(null)
            //the spelling new URL() hands over is caught as well
            expect(isPrivateIP('::ffff:7f00:1')).toBe(true)
            expect(isPrivateIP('::ffff:a9fe:a9fe')).toBe(true)
        })

        it('carries the exact safe message for each kind of rejection', async () => {
            await expect(resolveAndValidate('not a url')).rejects.toMatchObject({safeMessage: 'Invalid url', message: 'Invalid webhook url'})
            await expect(resolveAndValidate('ftp://example.com')).rejects.toMatchObject({safeMessage: 'Blocked URL scheme'})
            await expect(resolveAndValidate('http://[::ffff:127.0.0.1]/')).rejects.toMatchObject({safeMessage: 'Host resolves to a private address'})
        })

        it('does not put the url path, query or credentials in a rejection', async () => {
            const url = 'http://user:hunter2@[::ffff:127.0.0.1]:6379/secret-path?token=abc'
            const error = await resolveAndValidate(url).catch(e => e)
            expect(error.message).toBe('SSRF blocked: ::ffff:7f00:1 resolved to private IP ::ffff:7f00:1')
            for (const fragment of ['hunter2', 'user', 'secret-path', 'token'])
                expect(`${error.message} ${error.safeMessage}`).not.toContain(fragment)
        })
    })

    describe('resolveAndValidate deadline', () => {
        const dns = require('dns')
        let lookup
        let unsettled = []

        beforeEach(() => {
            //a lookup that does not settle on its own is the worst case, and it keeps these tests off the network
            unsettled = []
            lookup = jest.spyOn(dns.promises, 'lookup').mockImplementation(() => new Promise(resolve => unsettled.push(resolve)))
        })

        afterEach(async () => {
            //an abandoned lookup keeps its slot until it settles (the validator caps lookups in flight), so a test must
            //not hand the next one a slot it left occupied
            for (const resolve of unsettled)
                resolve({address: '8.8.8.8', family: 4})
            await new Promise(resolve => setImmediate(resolve))
            lookup.mockRestore()
        })

        it('rejects at once with the reason of a signal that has already fired', async () => {
            const controller = new AbortController()
            const reason = new Error('budget spent')
            reason.safeMessage = 'Request timed out'
            controller.abort(reason)
            await expect(resolveAndValidate('http://name.invalid/', {signal: controller.signal})).rejects.toBe(reason)
            expect(lookup).not.toHaveBeenCalled()
        })

        it('stops waiting for a lookup when the signal fires', async () => {
            const controller = new AbortController()
            const reason = new Error('budget spent')
            reason.safeMessage = 'Request timed out'
            const pending = resolveAndValidate('http://name.invalid/', {signal: controller.signal})
            setTimeout(() => controller.abort(reason), 20)
            await expect(pending).rejects.toBe(reason)
            expect(lookup).toHaveBeenCalledTimes(1)
            expect(lookup.mock.calls[0][0]).toBe('name.invalid')
        })

        it('reports a timeout when the signal carries no error of its own', async () => {
            const controller = new AbortController()
            controller.abort()
            await expect(resolveAndValidate('http://name.invalid/', {signal: controller.signal}))
                .rejects.toMatchObject({message: 'Host resolution aborted', safeMessage: 'Request timed out'})
        })

        it('checks an IP literal without resolving it', async () => {
            const controller = new AbortController()
            controller.abort()
            expect((await resolveAndValidate('http://8.8.8.8/', {signal: controller.signal})).resolvedIp).toBe('8.8.8.8')
            expect((await resolveAndValidate('http://[2001:4860:4860::8888]/')).resolvedIp).toBe('2001:4860:4860::8888')
            expect(lookup).not.toHaveBeenCalled()
        })

        it('refuses a name that resolves to a private address', async () => {
            lookup.mockImplementation(() => Promise.resolve({address: '::ffff:7f00:1', family: 6}))
            await expect(resolveAndValidate('http://rebind.example/')).rejects.toMatchObject({
                message: 'SSRF blocked: rebind.example resolved to private IP ::ffff:7f00:1',
                safeMessage: 'Host resolves to a private address'
            })
        })

        it('starts with every lookup slot free, whatever the earlier tests abandoned', async () => {
            const held = [resolveAndValidate('http://first.invalid/'), resolveAndValidate('http://second.invalid/')]
            held.forEach(request => request.catch(() => {}))
            expect(lookup).toHaveBeenCalledTimes(2)
            await expect(resolveAndValidate('http://third.invalid/')).rejects.toMatchObject({
                message: 'Host lookup refused: too many lookups in flight',
                safeMessage: 'Too many host lookups in progress'
            })
            expect(lookup).toHaveBeenCalledTimes(2)
        })
    })
})

describe('validateGatewayUrl', () => {
    const {validateGatewayUrl, maxGatewayUrls} = require('../../src/utils/ssrf-validator')

    test('an https gateway is returned with its trailing slashes removed', () => {
        expect(validateGatewayUrl('https://gw.example.com')).toBe('https://gw.example.com')
        expect(validateGatewayUrl('https://gw.example.com//')).toBe('https://gw.example.com')
        expect(validateGatewayUrl('https://gw.example.com:8443/base/')).toBe('https://gw.example.com:8443/base')
    })

    test('the parsed form is returned, so stray whitespace and host case never reach a request url', () => {
        expect(validateGatewayUrl(' https://GW.Example.com/ ')).toBe('https://gw.example.com')
        expect(validateGatewayUrl('https://gw.exa\tmple.com/base')).toBe('https://gw.example.com/base')
    })

    test('a bare ? or # is refused although it leaves search and hash empty', () => {
        expect(() => validateGatewayUrl('https://gw.example.com/?')).toThrow('Gateway URL must not contain a query string or a fragment')
        expect(() => validateGatewayUrl('https://gw.example.com/#')).toThrow('Gateway URL must not contain a query string or a fragment')
    })

    test('plain http is accepted, as the dashboard builds it', () => {
        expect(validateGatewayUrl('http://203.0.114.7:8080')).toBe('http://203.0.114.7:8080')
        expect(validateGatewayUrl('http://gw.example.com:8080/')).toBe('http://gw.example.com:8080')
    })

    test('another scheme, credentials, a query or a fragment are refused', () => {
        for (const url of ['ftp://gw.example.com', 'ws://gw.example.com', 'file:///etc/passwd', 'javascript:alert(1)'])
            expect(() => validateGatewayUrl(url)).toThrow('Gateway URL must use http or https, got ')
        expect(() => validateGatewayUrl('ftp://gw.example.com')).toThrow('Gateway URL must use http or https, got ftp:')
        expect(() => validateGatewayUrl('http://user:pw@gw.example.com')).toThrow('Gateway URL must not contain user information')
        expect(() => validateGatewayUrl('http://gw.example.com/?')).toThrow('Gateway URL must not contain a query string or a fragment')
        expect(() => validateGatewayUrl('http://10.0.0.5:8080')).toThrow('Gateway URL points at a private address')
        expect(() => validateGatewayUrl('https://user@gw.example.com')).toThrow('Gateway URL must not contain user information')
        expect(() => validateGatewayUrl('https://:pass@gw.example.com')).toThrow('Gateway URL must not contain user information')
        expect(() => validateGatewayUrl('https://gw.example.com/?a=b')).toThrow('Gateway URL must not contain a query string or a fragment')
        expect(() => validateGatewayUrl('https://gw.example.com/#x')).toThrow('Gateway URL must not contain a query string or a fragment')
    })

    test('an explicit private address is refused in every spelling', () => {
        for (const url of ['https://10.0.0.5', 'https://127.0.0.1:8443', 'https://169.254.169.254', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fd00::1]'])
            expect(() => validateGatewayUrl(url)).toThrow('Gateway URL points at a private address')
    })

    test('an empty, non-string, unparseable or oversized value is refused', () => {
        for (const value of ['', undefined, null, 42, ['https://gw.example.com']])
            expect(() => validateGatewayUrl(value)).toThrow('Gateway URL must be a non-empty string of at most 2048 characters')
        expect(() => validateGatewayUrl('not-a-url')).toThrow('Invalid URL')
        const long = 'https://gw.example.com/' + 'a'.repeat(2048 - 'https://gw.example.com/'.length)
        expect(validateGatewayUrl(long)).toBe(long)
        expect(() => validateGatewayUrl(long + 'a')).toThrow('Gateway URL must be a non-empty string of at most 2048 characters')
    })

    test('the gateway list is capped at ten', () => {
        expect(maxGatewayUrls).toBe(10)
    })
})

describe('IPv4-translated addresses', () => {
    const {validateGatewayUrl} = require('../../src/utils/ssrf-validator')

    test('are judged by the IPv4 address they carry', () => {
        expect(isPrivateIP('::ffff:0:7f00:1')).toBe(true) //127.0.0.1
        expect(isPrivateIP('::ffff:0:a9fe:a9fe')).toBe(true) //169.254.169.254
        expect(isPrivateIP('::ffff:0:a00:1')).toBe(true) //10.0.0.1
        expect(isPrivateIP('::ffff:0:808:808')).toBe(false) //8.8.8.8
    })

    test('a webhook and a gateway on a private one are refused', async () => {
        await expect(resolveAndValidate('http://[::ffff:0:7f00:1]/')).rejects.toMatchObject({safeMessage: 'Host resolves to a private address'})
        expect(() => validateGatewayUrl('https://[::ffff:0:7f00:1]')).toThrow('Gateway URL points at a private address')
    })
})
