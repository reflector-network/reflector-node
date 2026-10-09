/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')

const posixTest = process.platform === 'win32' ? test.skip : test

/**
 * Loads a fresh nonce manager over a home directory, as a boot does
 * @param {string} home - home directory
 * @returns {object} the nonce manager
 */
function loadNonceManager(home) {
    let manager = null
    jest.isolateModules(() => {
        jest.doMock('../../src/domain/container', () => ({homeDir: home}))
        manager = require('../../src/ws-server/nonce-manager')
    })
    return manager
}

describe('nonce-manager persistence', () => {
    let home

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-nonces-'))
    })

    afterEach(() => {
        for (const name of fs.readdirSync(home))
            fs.rmSync(path.join(home, name), {force: true})
        fs.rmdirSync(home)
    })

    test('a torn nonce file stops the boot with a message naming it, and is left as it was', () => {
        fs.writeFileSync(path.join(home, '.nonce.json'), '{"config": 17')
        expect(() => loadNonceManager(home)).toThrow('.nonce.json cannot be parsed')
        expect(fs.readFileSync(path.join(home, '.nonce.json'), 'utf8')).toBe('{"config": 17')
    })

    test('a nonce file that is not an object stops the boot too', () => {
        fs.writeFileSync(path.join(home, '.nonce.json'), '[1, 2]')
        expect(() => loadNonceManager(home)).toThrow('does not hold a nonce object')
    })

    test('a missing file starts empty and setNonce replaces the file whole', () => {
        const nonceManager = loadNonceManager(home)
        expect(nonceManager.getNonce('config')).toBe(0)
        const rename = jest.spyOn(fs, 'renameSync')
        try {
            nonceManager.setNonce('config', 5)
            expect(rename).toHaveBeenCalledWith(`${home}/.nonce.json.${process.pid}.tmp`, `${home}/.nonce.json`)
        } finally {
            rename.mockRestore()
        }
        expect(JSON.parse(fs.readFileSync(path.join(home, '.nonce.json'), 'utf8'))).toEqual({config: 5})
        expect(fs.readdirSync(home)).toEqual(['.nonce.json'])
    })

    test('the legacy key 3 is still read as config', () => {
        fs.writeFileSync(path.join(home, '.nonce.json'), '{"3": 9}')
        expect(loadNonceManager(home).getNonce('config')).toBe(9)
    })

    posixTest('the nonce file is owner-only', () => {
        loadNonceManager(home).setNonce('config', 5)
        expect(fs.statSync(path.join(home, '.nonce.json')).mode & 0o777).toBe(0o600)
    })
})
