/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {execFileSync} = require('child_process')

const root = path.resolve(__dirname, '..')

/**
 * @returns {boolean} whether the suite runs inside a git work tree; a tarball or a docker build context has none, and
 * there git check-ignore cannot answer
 */
function insideWorkTree() {
    try {
        return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {cwd: root, stdio: 'pipe'}).toString().trim() === 'true'
    } catch (err) {
        return false
    }
}

const describeInWorkTree = insideWorkTree() ? describe : describe.skip

/**
 * @param {string} file - repository-relative path
 * @returns {boolean} whether a rule in the ignore files matches it. --no-index, because check-ignore otherwise answers
 * "not ignored" for every tracked file whatever the rules say
 */
function isIgnored(file) {
    try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', file], {cwd: root, stdio: 'ignore'})
        return true
    } catch (err) {
        return false
    }
}

//Git for Windows defaults to core.autocrlf=true, so any checkout there - a merge, a branch switch, a fresh clone - would
//write the entrypoint with CRLF, the image build copies it as it is, and the container dies on `bash\r`
describeInWorkTree('the docker entrypoint is checked out with LF endings everywhere', () => {
    test('git attributes pin docker/startnode to text with eol=lf', () => {
        const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', 'docker/startnode'], {cwd: root, stdio: 'pipe'}).toString()
        expect(attributes.replace(/\r\n/g, '\n')).toBe('docker/startnode: text: set\ndocker/startnode: eol: lf\n')
    })

    test('the entrypoint in the work tree and in the index has no carriage return', () => {
        expect(fs.readFileSync(path.join(root, 'docker', 'startnode')).includes(0x0d)).toBe(false)
        const blob = execFileSync('git', ['show', ':docker/startnode'], {cwd: root, stdio: 'pipe'})
        expect(blob.includes(0x0d)).toBe(false)
        expect(blob.toString().startsWith('#!/usr/bin/env bash\n')).toBe(true)
    })
})

describeInWorkTree('generated secrets and stray artifacts are ignored', () => {
    test.each([
        'tests/cluster/rsa.json',
        'tests/cluster/token-data.json',
        'tests/cluster/webhook.json',
        'tests/cluster/reflector_oracle.wasm',
        'collected-logs.json',
        'scripts/repro-usdp-spike.js',
        'docs/superpowers/specs/grep.exe.stackdump'
    ])('%s is ignored', file => {
        expect(isIgnored(file)).toBe(true)
    })

    test.each(['tests/cluster/run-cluster.js', 'src/index.js', 'package-lock.json'])('%s is not', file => {
        expect(isIgnored(file)).toBe(false)
    })

    test('no tracked file matches an ignore rule', () => {
        const matched = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard'], {cwd: root, stdio: 'pipe'}).toString()
        expect(matched).toBe('')
    })
})
