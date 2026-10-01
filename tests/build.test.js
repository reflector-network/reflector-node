/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')

describe('the release build installs exactly the lockfile', () => {
    let root

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-build-'))
        fs.mkdirSync(path.join(root, 'src', 'home'), {recursive: true})
        fs.writeFileSync(path.join(root, 'src', 'index.js'), '//entry')
        fs.writeFileSync(path.join(root, 'src', 'home', 'app.config.json'), '{"secret": "not shipped"}')
        fs.writeFileSync(path.join(root, 'package.json'), '{"name": "fixture"}')
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion": 3}')
    })

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    })

    test('dist carries the sources, package.json and the lockfile, and npm ci installs from them', () => {
        const {build} = require('../build')
        const exec = jest.fn()

        build({rootDir: root, exec})

        const dist = path.join(root, 'dist')
        expect(fs.readFileSync(path.join(dist, 'app', 'index.js'), 'utf8')).toBe('//entry')
        expect(fs.existsSync(path.join(dist, 'app', 'home'))).toBe(false)
        expect(fs.readFileSync(path.join(dist, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion": 3}')
        expect(exec).toHaveBeenCalledWith('npm ci --omit=dev', {cwd: dist, stdio: 'inherit'})
    })

    test('without a lockfile the build stops before installing anything', () => {
        const {build} = require('../build')
        fs.rmSync(path.join(root, 'package-lock.json'))
        const exec = jest.fn()

        expect(() => build({rootDir: root, exec})).toThrow('package-lock.json is required')
        expect(exec).not.toHaveBeenCalled()
    })

    test('the install runs once, after package.json and the lockfile are in dist, and a stale dist is replaced', () => {
        const {build} = require('../build')
        const dist = path.join(root, 'dist')
        fs.mkdirSync(path.join(dist, 'app'), {recursive: true})
        fs.writeFileSync(path.join(dist, 'app', 'stale.js'), '//from an earlier build')
        const seen = []
        const exec = jest.fn((command, {cwd}) => {
            seen.push(fs.readdirSync(cwd).sort())
        })

        build({rootDir: root, exec})

        expect(exec).toHaveBeenCalledTimes(1)
        expect(seen).toEqual([['app', 'package-lock.json', 'package.json']])
        expect(fs.readFileSync(path.join(dist, 'package.json'), 'utf8')).toBe('{"name": "fixture"}')
        expect(fs.existsSync(path.join(dist, 'app', 'stale.js'))).toBe(false)
    })
})
