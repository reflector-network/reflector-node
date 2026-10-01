/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {writeFileAtomic} = require('../../src/utils/fs-helper')

const posixTest = process.platform === 'win32' ? test.skip : test

describe('writeFileAtomic', () => {
    let dir

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-fs-helper-'))
    })

    afterEach(() => {
        for (const name of fs.readdirSync(dir))
            fs.rmSync(path.join(dir, name), {force: true})
        fs.rmdirSync(dir)
    })

    test('replaces the file whole and leaves no temporary file', () => {
        const file = path.join(dir, 'state.json')
        fs.writeFileSync(file, 'old content')
        writeFileAtomic(file, '{"a":1}')
        expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}')
        expect(fs.readdirSync(dir)).toEqual(['state.json'])
    })

    test('a failed write leaves the old file and no temporary file', () => {
        const file = path.join(dir, 'state.json')
        fs.writeFileSync(file, 'old content')
        const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
            throw new Error('ENOSPC: no space left on device')
        })
        try {
            expect(() => writeFileAtomic(file, 'new content')).toThrow('ENOSPC')
        } finally {
            write.mockRestore()
        }
        expect(fs.readFileSync(file, 'utf8')).toBe('old content')
        expect(fs.readdirSync(dir)).toEqual(['state.json'])
    })

    posixTest('creates the file readable by its owner only', () => {
        const file = path.join(dir, 'secret.json')
        writeFileAtomic(file, '{}')
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    })

    test('temporary files an earlier process left for the target are removed, and nothing else', () => {
        const file = path.join(dir, 'state.json')
        for (const name of ['state.json.99999.tmp', 'state.json.1.tmp', 'other.json.5.tmp', 'state.json.bak', 'state.json.x.tmp'])
            fs.writeFileSync(path.join(dir, name), 'left over')

        writeFileAtomic(file, '{"a":1}')

        expect(fs.readdirSync(dir).sort()).toEqual(['other.json.5.tmp', 'state.json', 'state.json.bak', 'state.json.x.tmp'])
    })

    test('the directory is flushed after the rename', () => {
        const file = path.join(dir, 'state.json')
        const rename = jest.spyOn(fs, 'renameSync')
        const open = jest.spyOn(fs, 'openSync')
        try {
            writeFileAtomic(file, '{}')
            const dirOpen = open.mock.calls.findIndex(([target, flags]) => target === dir && flags === 'r')
            expect(dirOpen).toBeGreaterThanOrEqual(0)
            expect(open.mock.invocationCallOrder[dirOpen]).toBeGreaterThan(rename.mock.invocationCallOrder[0])
        } finally {
            rename.mockRestore()
            open.mockRestore()
        }
    })

    test.each(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'])('a directory flush the platform refuses with %s does not fail the write', code => {
        const file = path.join(dir, 'state.json')
        const realOpen = fs.openSync
        const open = jest.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
            if (target === dir)
                throw Object.assign(new Error(`${code}: refused`), {code})
            return realOpen(target, ...rest)
        })
        try {
            writeFileAtomic(file, '{"a":1}')
        } finally {
            open.mockRestore()
        }
        expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}')
    })

    test('any other directory flush failure is reported', () => {
        const file = path.join(dir, 'state.json')
        const realOpen = fs.openSync
        const open = jest.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
            if (target === dir)
                throw Object.assign(new Error('EIO: i/o error'), {code: 'EIO'})
            return realOpen(target, ...rest)
        })
        try {
            expect(() => writeFileAtomic(file, '{}')).toThrow('EIO')
        } finally {
            open.mockRestore()
        }
    })

    test('a failed cleanup does not hide the error that stopped the write', () => {
        const file = path.join(dir, 'state.json')
        const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
            throw new Error('ENOSPC: no space left on device')
        })
        const remove = jest.spyOn(fs, 'rmSync').mockImplementation(() => {
            throw new Error('EBUSY: resource busy or locked')
        })
        try {
            expect(() => writeFileAtomic(file, 'new content')).toThrow('ENOSPC')
        } finally {
            write.mockRestore()
            remove.mockRestore()
        }
    })
})
