/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {execFileSync} = require('child_process')
const {checkGateways} = require('../../src/utils/check-gateways')

const challenge = 'b8b4a2f0c1d24e7f9a3b5c6d7e8f9012'
const file = content => JSON.stringify(content)
const script = path.resolve(__dirname, '../../src/utils/check-gateways.js')

/**
 * Runs the command line and returns what it printed and how it exited, whatever the exit code
 * @param {string[]} args - command-line arguments
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(args) {
    try {
        const stdout = execFileSync(process.execPath, [script, ...args], {stdio: 'pipe'}).toString()
        return {status: 0, stdout, stderr: ''}
    } catch (err) {
        return {status: err.status, stdout: err.stdout.toString(), stderr: err.stderr.toString()}
    }
}

describe('checkGateways, the release pre-flight over gateways.json', () => {
    test.each([
        ['no file', null],
        ['an empty list', file({urls: [], challenge})],
        ['a missing list', file({challenge})],
        ['a null list', file({urls: null, challenge})],
        ['an empty list without a challenge', file({urls: []})]
    ])('%s is no gateways configured', (_, content) => {
        expect(checkGateways(content)).toEqual({state: 'none', problems: []})
    })

    test('http and https gateways on public hosts are usable', () => {
        expect(checkGateways(file({urls: ['http://203.0.114.7:8080', 'https://gw.example.com'], challenge}))).toEqual({state: 'usable', problems: []})
    })

    //an editor on Windows may save the file with a UTF-8 byte-order mark. The node reads it as text and trims it
    //(SettingsManager.init), which drops the mark, so the file is usable there; the pre-flight must say the same
    test('a byte-order mark before the JSON is read past, as the node reads it', () => {
        const bom = String.fromCharCode(0xfeff)
        const content = file({urls: ['https://gw.example.com'], challenge})
        expect(checkGateways(`${bom}${content}`)).toEqual({state: 'usable', problems: []})
        expect(checkGateways(`${bom}${file({urls: [], challenge})}`)).toEqual({state: 'none', problems: []})
        expect(`${bom}${content}`.trim()).toBe(content)
    })

    test('ten urls are allowed', () => {
        const urls = Array.from({length: 10}, (_, i) => `https://gw${i}.example.com`)
        expect(checkGateways(file({urls, challenge}))).toEqual({state: 'usable', problems: []})
    })

    test.each([
        ['torn json', '{"urls": ["https://gw.example.com"], "challenge": ', 'gateways.json is not valid JSON'],
        ['json that is not an object', 'null', 'gateways.json does not hold an object'],
        ['a top-level array', file(['https://gw.example.com']), 'gateways.json does not hold an object'],
        ['a list that is not an array', file({urls: 'https://gw.example.com', challenge}), 'urls is not an array'],
        ['eleven urls', file({urls: Array.from({length: 11}, (_, i) => `https://gw${i}.example.com`), challenge}), 'more than 10 urls'],
        ['no challenge', file({urls: ['https://gw.example.com']}), 'a non-empty list needs a string challenge'],
        ['an empty challenge', file({urls: ['https://gw.example.com'], challenge: ''}), 'a non-empty list needs a string challenge'],
        ['a numeric challenge', file({urls: ['https://gw.example.com'], challenge: 7}), 'a non-empty list needs a string challenge']
    ])('%s is configured but unusable', (_, content, problem) => {
        expect(checkGateways(content)).toEqual({state: 'unusable', problems: [problem]})
    })

    test.each([
        ['a private address', 'http://10.0.0.5:8080', 'urls[0]: Gateway URL points at a private address: 10.0.0.5'],
        ['loopback', 'http://127.0.0.1:8080', 'urls[0]: Gateway URL points at a private address: 127.0.0.1'],
        ['an IPv4-translated address', 'http://[::ffff:0:a00:5]:8080', 'urls[0]: Gateway URL points at a private address: ::ffff:0:a00:5'],
        ['user information', 'https://user:pass@gw.example.com', 'urls[0]: Gateway URL must not contain user information (host: gw.example.com)'],
        ['a bare query mark', 'https://gw.example.com/?', 'urls[0]: Gateway URL must not contain a query string or a fragment (host: gw.example.com)'],
        ['a fragment', 'https://gw.example.com/#top', 'urls[0]: Gateway URL must not contain a query string or a fragment (host: gw.example.com)'],
        ['ftp', 'ftp://gw.example.com', 'urls[0]: Gateway URL must use http or https, got ftp: (host: gw.example.com)'],
        ['a url over 2048 characters', `https://gw.example.com/${'a'.repeat(2048)}`,
            'urls[0]: Gateway URL must be a non-empty string of at most 2048 characters (host: gw.example.com)'],
        ['text that is not a url', 'not a url', 'urls[0]: Invalid URL'],
        ['a number', 5, 'urls[0]: Gateway URL must be a non-empty string of at most 2048 characters']
    ])('a list holding only %s is unusable, and says why by position', (_, url, problem) => {
        expect(checkGateways(file({urls: [url], challenge}))).toEqual({state: 'unusable', problems: [problem]})
    })

    test('a partly rejected list is usable, and the rejected entry is reported by position', () => {
        const result = checkGateways(file({urls: ['https://gw.example.com', 'http://127.0.0.1:8080'], challenge}))
        expect(result).toEqual({state: 'usable', problems: ['urls[1]: Gateway URL points at a private address: 127.0.0.1']})
    })

    test('a problem names the host and the position, never the url with its path, credentials or query', () => {
        const url = 'https://operator:s3cr3t-pass@gw.example.com/route-token-7f3a?key=q-token-91'
        const [problem] = checkGateways(file({urls: [url], challenge})).problems
        expect(problem).toBe('urls[0]: Gateway URL must not contain user information (host: gw.example.com)')
        for (const part of ['s3cr3t-pass', 'operator', 'route-token-7f3a', 'q-token-91'])
            expect(problem).not.toContain(part)
    })
})

describe('check-gateways.js on the command line', () => {
    let dir

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-check-gateways-'))
    })

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    })

    /**
     * @param {string} name - file name in the temporary directory
     * @param {string} content - file content
     * @returns {string} the file's path
     */
    function write(name, content) {
        const target = path.join(dir, name)
        fs.writeFileSync(target, content)
        return target
    }

    test('a usable file exits 0 and prints the result as JSON', () => {
        const good = write('good.json', file({urls: ['https://gw.example.com'], challenge}))
        const result = run([good])
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({file: good, state: 'usable', problems: []})
    })

    test('a file saved with a UTF-8 byte-order mark exits 0 as usable', () => {
        const target = path.join(dir, 'bom.json')
        fs.writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(file({urls: ['https://gw.example.com'], challenge}))]))
        const result = run([target])
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({file: target, state: 'usable', problems: []})
    })

    test('an empty list exits 0 as no gateways configured', () => {
        const empty = write('empty.json', file({urls: [], challenge}))
        const result = run([empty])
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout).state).toBe('none')
    })

    test('an unusable file exits 1', () => {
        const bad = write('bad.json', file({urls: ['http://10.0.0.5:8080'], challenge}))
        const result = run([bad])
        expect(result.status).toBe(1)
        expect(JSON.parse(result.stdout)).toEqual({
            file: bad,
            state: 'unusable',
            problems: ['urls[0]: Gateway URL points at a private address: 10.0.0.5']
        })
    })

    test('a partly rejected list exits 1: it routes through fewer gateways than configured', () => {
        const partial = write('partial.json', file({urls: ['https://gw.example.com', 'http://127.0.0.1:8080'], challenge}))
        const result = run([partial])
        expect(result.status).toBe(1)
        expect(JSON.parse(result.stdout).state).toBe('usable')
    })

    test('a torn file exits 1 without quoting its content', () => {
        const torn = write('torn.json', '{"urls": ["https://gw.example.com/token-in-path-5c2e"], "challenge": ')
        const result = run([torn])
        expect(result.status).toBe(1)
        expect(JSON.parse(result.stdout).problems).toEqual(['gateways.json is not valid JSON'])
        expect(result.stdout + result.stderr).not.toContain('token-in-path-5c2e')
    })

    test('the printed output carries hosts and positions, never a full gateway url', () => {
        const urls = [
            'https://gw.example.com/usable-token-a1',
            'https://operator:pass-token-b2@gw2.example.com/path-token-c3',
            'ftp://gw3.example.com/ftp-token-d4'
        ]
        const result = run([write('mixed.json', file({urls, challenge}))])
        expect(result.status).toBe(1)
        expect(JSON.parse(result.stdout).problems).toEqual([
            'urls[1]: Gateway URL must not contain user information (host: gw2.example.com)',
            'urls[2]: Gateway URL must use http or https, got ftp: (host: gw3.example.com)'
        ])
        for (const secret of ['usable-token-a1', 'pass-token-b2', 'path-token-c3', 'ftp-token-d4', 'operator'])
            expect(result.stdout + result.stderr).not.toContain(secret)
    })

    test('a path that does not exist fails with a warning unless --missing-ok says the node has no gateways.json', () => {
        const missing = path.join(dir, 'gateways.json')
        const refused = run([missing])
        expect(refused.status).toBe(1)
        expect(refused.stdout).toBe('')
        expect(refused.stderr).toContain('does not exist; pass --missing-ok for a node that has no gateways.json')

        for (const args of [['--missing-ok', missing], [missing, '--missing-ok']]) {
            const accepted = run(args)
            expect(accepted.status).toBe(0)
            expect(JSON.parse(accepted.stdout)).toEqual({file: missing, state: 'none', problems: []})
        }
    })

    //a pre-flight loop passes --missing-ok for every node, so a mistyped home must not pass as "no gateways"
    test('--missing-ok still fails when the home the path names does not exist or is not a directory', () => {
        const typoHome = path.join(dir, 'no-such-home')
        const notADirectory = write('app.config.json', '{}')
        for (const home of [typoHome, notADirectory]) {
            const target = path.join(home, 'gateways.json')
            for (const args of [['--missing-ok', target], [target, '--missing-ok']]) {
                const result = run(args)
                expect(result.status).toBe(1)
                expect(result.stdout).toBe('')
                expect(result.stderr).toBe(`${home} is not a node home: it does not exist or is not a directory\n`)
            }
        }
    })

    test('--missing-ok does not excuse a file that exists and is unusable', () => {
        const bad = write('bad.json', file({urls: ['http://10.0.0.5:8080'], challenge}))
        const result = run(['--missing-ok', bad])
        expect(result.status).toBe(1)
        expect(JSON.parse(result.stdout).state).toBe('unusable')
    })

    test('a path that cannot be read as a file exits 1 as unusable', () => {
        const result = run([dir])
        expect(result.status).toBe(1)
        expect(JSON.parse(result.stdout)).toEqual({file: dir, state: 'unusable', problems: ['gateways.json cannot be read']})
    })

    test('no path prints the usage and exits 2, with or without --missing-ok', () => {
        for (const args of [[], ['--missing-ok']]) {
            const result = run(args)
            expect(result.status).toBe(2)
            expect(result.stderr).toContain('usage: node check-gateways.js [--missing-ok] <path to gateways.json>')
        }
    })
})
