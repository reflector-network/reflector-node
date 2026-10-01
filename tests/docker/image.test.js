/*eslint-disable no-undef */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {execFileSync, spawnSync} = require('child_process')
const {Keypair} = require('@stellar/stellar-sdk')

const root = path.resolve(__dirname, '../..')
const script = path.join(root, 'src', 'utils', 'get-pubkey.js')
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')

/**
 * Runs get-pubkey.js and returns how it ended, whatever the exit code
 * @param {string[]} args - command-line arguments
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runGetPubkey(args) {
    const result = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'})
    return {status: result.status, stdout: result.stdout, stderr: result.stderr}
}

describe('the node image keeps the seed off command lines and drops root', () => {
    test('get-pubkey derives the public key from app.config.json itself', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-pubkey-'))
        const kp = Keypair.random()
        try {
            fs.writeFileSync(path.join(dir, 'app.config.json'), JSON.stringify({secret: kp.secret()}))
            expect(execFileSync(process.execPath, [script, path.join(dir, 'app.config.json')]).toString().trim()).toBe(kp.publicKey())
        } finally {
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })

    test('a seed passed in place of the path is refused without being echoed', () => {
        const kp = Keypair.random()
        let failure = null
        try {
            execFileSync(process.execPath, [script, kp.secret()], {stdio: 'pipe'})
        } catch (err) {
            failure = err
        }
        expect(failure).not.toBeNull()
        expect(failure.stderr.toString()).toContain('Pass the path of app.config.json, not the secret key')
        expect(failure.stderr.toString()).not.toContain(kp.secret())
    })

    test('an app.config.json that is not valid JSON is refused without quoting the seed next to the error', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-pubkey-'))
        const kp = Keypair.random()
        try {
            //an unquoted seed: the parser's own message would quote the text around it
            fs.writeFileSync(path.join(dir, 'app.config.json'), `{"secret": ${kp.secret()}}`)
            const result = runGetPubkey([path.join(dir, 'app.config.json')])
            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain('app.config.json is not valid JSON')
            expect(result.stdout + result.stderr).not.toContain(kp.secret())
            expect(result.stdout + result.stderr).not.toContain(kp.secret().slice(0, 12))
        } finally {
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })

    test('get-pubkey without a path, or with a config that has no secret, fails with a message', () => {
        expect(runGetPubkey([]).stderr).toContain('Path to app.config.json is required')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-pubkey-'))
        try {
            fs.writeFileSync(path.join(dir, 'app.config.json'), JSON.stringify({port: 30347}))
            const result = runGetPubkey([path.join(dir, 'app.config.json')])
            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain('Secret key is not provided. Check app.config.json')
        } finally {
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })

    test('startnode never reads the seed into a variable or an argument', () => {
        const startnode = read('docker/startnode')
        expect(startnode).not.toMatch(/\.secret/)
        expect(startnode).not.toMatch(/SECRET_KEY/)
        expect(startnode).toMatch(/get-pubkey\.js "\$CONFIG_FILE"/)
    })

    test('startnode refuses to run as anything but root before its first other command', () => {
        const commands = read('docker/startnode').split('\n').filter(line => line.trim() && !line.startsWith('#'))
        expect(commands.slice(0, 2)).toEqual(['set -euo pipefail', 'if [ "$(id -u)" -ne 0 ]; then'])
    })

    test('startnode hands the mounted home to the node user and closes it to others, or says why it cannot', () => {
        const startnode = read('docker/startnode')
        expect(startnode).toMatch(/^set -euo pipefail$/m)
        expect(startnode).toMatch(/^chown -R node:node "\$MOUNT_DIR" \|\| home_error /m)
        expect(startnode).toMatch(/^chmod 700 "\$MOUNT_DIR" \|\| home_error /m)
        expect(startnode).toMatch(/^mkdir -p "\$MOUNT_DIR\/logs" "\$MOUNT_DIR\/promtail" \|\| home_error /m)
        expect(startnode).toContain('must be writable and chown-able by root')
    })

    test('promtail pushes over https even when orchestratorUrl is wss', () => {
        const startnode = read('docker/startnode')
        expect(startnode).toContain("LOKI_BASE_URL=$(printf '%s' \"$ORCHESTRATOR_URL\" | sed 's|^[Ww][Ss][Ss]://|https://|')")
        expect(startnode).toContain('s|__ORCHESTRATOR_URL__|${LOKI_BASE_URL}|g')
    })

    test('supervisord runs the node and promtail as the node user', () => {
        const programs = read('docker/supervisord.conf').split('[program:').slice(1)
        expect(programs).toHaveLength(2)
        for (const program of programs)
            expect(program).toMatch(/^user=node$/m)
    })
})

/**
 * @returns {boolean} whether a bash that understands this platform's paths is available: a POSIX bash, or on Windows the
 * Git Bash / MSYS one (a WSL bash would read C:/ paths as relative ones)
 */
function hasNativeBash() {
    const result = spawnSync('bash', ['-c', 'uname -s'], {encoding: 'utf8'})
    if (result.status !== 0)
        return false
    const system = result.stdout.trim()
    return process.platform === 'win32' ? /^(MINGW|MSYS|CYGWIN)/.test(system) : /^(Linux|Darwin|FreeBSD)/.test(system)
}

const describeWithBash = hasNativeBash() ? describe : describe.skip
const posix = p => p.split(path.sep).join('/')

/**
 * Runs docker/startnode outside docker: the image paths point into a temporary directory, and mountpoint, chown, chmod,
 * mkdir, jq, node and supervisord are shims that record their arguments and fail on request. jq is a node stand-in that
 * prints `.orchestratorUrl` as `jq -r` does; the real jq runs only in the image (maintainer check)
 */
describeWithBash('docker/startnode, run with stand-ins for the image tools', () => {
    let dir
    let home
    let shims
    let logs

    /**
     * @param {string} name - shim name
     * @param {string} body - bash body
     */
    function shim(name, body) {
        const file = path.join(shims, name)
        fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
        fs.chmodSync(file, 0o755)
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflector-startnode-'))
        home = path.join(dir, 'home')
        shims = path.join(dir, 'bin')
        logs = path.join(dir, 'calls')
        for (const d of [home, shims, logs, path.join(dir, 'etc', 'promtail')])
            fs.mkdirSync(d, {recursive: true})
        fs.copyFileSync(path.join(root, 'docker', 'promtail', 'config.yml.template'), path.join(dir, 'etc', 'promtail', 'config.yml.template'))
        const real = name => spawnSync('bash', ['-c', `command -v ${name}`], {encoding: 'utf8'}).stdout.trim()
        const record = name => `printf '%s\\n' "$*" >> "${posix(logs)}/${name}"`
        const node = posix(process.execPath)
        shim('mountpoint', `${record('mountpoint')}\nexit 0`)
        //the entrypoint must start as root; the stand-in reports root unless a test sets FAKE_UID
        shim('id', `if [ "$1" = "-u" ]; then echo "\${FAKE_UID:-0}"; else exec "${real('id')}" "$@"; fi`)
        shim('mkdir', `if [ -n "\${FAIL_MKDIR:-}" ]; then echo "mkdir: Read-only file system" >&2; exit 1; fi\n${record('mkdir')}\nexec "${real('mkdir')}" "$@"`)
        shim('chown', `if [ -n "\${FAIL_CHOWN:-}" ]; then echo "chown: Operation not permitted" >&2; exit 1; fi\n${record('chown')}`)
        shim('chmod', `if [ -n "\${FAIL_CHMOD:-}" ]; then echo "chmod: Operation not permitted" >&2; exit 1; fi\n${record('chmod')}`)
        shim('jq', `exec "${node}" -e "let v; try { v = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')) } catch (e) { console.error('jq: parse error'); process.exit(2) } if (!v || typeof v !== 'object' || Array.isArray(v)) { console.error('jq: cannot index'); process.exit(5) } const x = v.orchestratorUrl; console.log(x === undefined || x === null ? 'null' : String(x))" "$3"`)
        shim('node', `${record('node')}\nexec "${node}" "$@"`)
        shim('supervisord', `${record('supervisord')}\nexit 0`)
        const startnode = read('docker/startnode')
            .split('/reflector-node/app/utils/get-pubkey.js').join(posix(script))
            .split('/reflector-node/app/home').join(posix(home))
            .split('/etc/promtail').join(posix(path.join(dir, 'etc', 'promtail')))
            .split('/usr/bin/supervisord').join('supervisord')
        fs.writeFileSync(path.join(dir, 'startnode'), startnode)
    })

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    })

    /**
     * @param {object} [env] - extra environment, e.g. FAIL_CHOWN
     * @returns {{status: number, output: string, stderr: string}}
     */
    function start(env = {}) {
        const result = spawnSync('bash', [posix(path.join(dir, 'startnode'))], {
            encoding: 'utf8',
            env: {...process.env, ...env, PATH: `${shims}${path.delimiter}${process.env.PATH}`}
        })
        return {status: result.status, output: result.stdout + result.stderr, stderr: result.stderr}
    }

    const called = name => fs.existsSync(path.join(logs, name)) ? fs.readFileSync(path.join(logs, name), 'utf8') : ''
    const promtailConfig = () => fs.readFileSync(path.join(dir, 'etc', 'promtail', 'config.yml'), 'utf8')
    const writeConfig = content => fs.writeFileSync(path.join(home, 'app.config.json'), content)

    test('a wss orchestratorUrl gives promtail an https push url, and the seed never reaches a command line or the output', () => {
        const kp = Keypair.random()
        writeConfig(JSON.stringify({secret: kp.secret(), orchestratorUrl: 'wss://orchestrator.example.com'}))

        const result = start()

        expect(result.status).toBe(0)
        expect(promtailConfig()).toContain('  - url: https://orchestrator.example.com/loki-proxy/loki/api/v1/push\n')
        expect(promtailConfig()).toContain(`job: '${kp.publicKey()}'`)
        expect(called('chown')).toBe(`-R node:node ${posix(home)}\n`)
        expect(called('chmod')).toBe(`700 ${posix(home)}\n`)
        expect(called('supervisord')).toBe('-c /etc/supervisor/conf.d/supervisord.conf\n')
        expect(called('node')).toBe(`${posix(script)} ${posix(home)}/app.config.json\n`)
        expect(result.output).toContain(`Public Key: ${kp.publicKey()}`)
        for (const text of [result.output, called('node'), called('chown'), called('chmod'), called('mkdir'), promtailConfig()])
            expect(text).not.toContain(kp.secret())
    })

    test.each([
        ['WSS://orchestrator.example.com', 'https://orchestrator.example.com'],
        ['https://orchestrator.example.com', 'https://orchestrator.example.com'],
        ['https://orchestrator.example.com/base', 'https://orchestrator.example.com/base']
    ])('orchestratorUrl %s pushes to %s', (orchestratorUrl, base) => {
        writeConfig(JSON.stringify({secret: Keypair.random().secret(), orchestratorUrl}))
        expect(start().status).toBe(0)
        expect(promtailConfig()).toContain(`  - url: ${base}/loki-proxy/loki/api/v1/push\n`)
    })

    test('no orchestratorUrl pushes to the default orchestrator', () => {
        writeConfig(JSON.stringify({secret: Keypair.random().secret()}))
        expect(start().status).toBe(0)
        expect(promtailConfig()).toContain('  - url: https://orchestrator.reflector.network/loki-proxy/loki/api/v1/push\n')
    })

    test.each([
        ['FAIL_MKDIR', 'ERROR: cannot create the logs and promtail directories. The mounted home'],
        ['FAIL_CHOWN', 'ERROR: cannot give the home to the node user (uid 1000). The mounted home'],
        ['FAIL_CHMOD', 'ERROR: cannot close the home to other users. The mounted home']
    ])('with %s the container stops before starting anything and says what the home needs', (failure, message) => {
        writeConfig(JSON.stringify({secret: Keypair.random().secret()}))

        const result = start({[failure]: '1'})

        expect(result.status).toBe(1)
        expect(result.stderr).toContain(message)
        expect(result.stderr).toContain('must be writable and chown-able by root: a read-only mount, a root-squashed network share or a container started with --user cannot run this release')
        expect(called('node')).toBe('')
        expect(called('supervisord')).toBe('')
    })

    //with --user 1000 over a home that uid 1000 already owns - after any start of this release - mkdir, chown and chmod
    //all succeed, and the script would die later on the promtail config with a bare "Permission denied"
    test('a container started as another user stops at the top and says why, before touching the home', () => {
        writeConfig(JSON.stringify({secret: Keypair.random().secret()}))

        const result = start({FAKE_UID: '1000'})

        expect(result.status).toBe(1)
        expect(result.stderr).toBe('ERROR: the entrypoint must start as root: it hands the mounted home to the node user '
            + '(uid 1000) and then runs the node as that user. Do not start the container with --user\n')
        for (const tool of ['mountpoint', 'mkdir', 'chown', 'chmod', 'node', 'supervisord'])
            expect(called(tool)).toBe('')
        expect(fs.existsSync(path.join(dir, 'etc', 'promtail', 'config.yml'))).toBe(false)
    })

    test('a failed chown stops the script before chmod runs', () => {
        writeConfig(JSON.stringify({secret: Keypair.random().secret()}))
        expect(start({FAIL_CHOWN: '1'}).status).toBe(1)
        expect(called('chmod')).toBe('')
    })

    test('an app.config.json that is not JSON stops the container with a message, never quoting it', () => {
        const kp = Keypair.random()
        writeConfig(`{"secret": ${kp.secret()}}`)

        const result = start()

        expect(result.status).toBe(1)
        expect(result.stderr).toContain(`ERROR: ${posix(home)}/app.config.json is not a valid JSON object`)
        expect(result.output).not.toContain(kp.secret())
        expect(called('supervisord')).toBe('')
    })

    test('a home without app.config.json stops the container with a message instead of an empty public key', () => {
        const result = start()

        expect(result.status).toBe(1)
        expect(result.stderr).toContain(`ERROR: cannot derive the node public key from ${posix(home)}/app.config.json`)
        expect(called('supervisord')).toBe('')
    })
})
