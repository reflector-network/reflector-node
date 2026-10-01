/*eslint-disable no-undef */
//dns is stubbed throughout, so no name leaves the machine. Each test loads a fresh copy of the validator, because the
//count of lookups in flight is module state and a test must not inherit the slots a previous one left occupied.
const path = require('path')
const {execFileSync} = require('child_process')

let mockLookup = null
jest.mock('dns', () => {
    const actual = jest.requireActual('dns')
    return {...actual, promises: {...actual.promises, lookup: (...args) => mockLookup(...args)}}
})

const capMessage = 'Too many host lookups in progress'
const publicAnswer = {address: '93.184.216.34', family: 4}
let pending = []
let calls = 0

//a resolver that never answers on its own: the test decides when, and whether, each lookup settles
function hangingLookup() {
    calls++
    return new Promise((resolve, reject) => pending.push({resolve, reject}))
}

function loadValidator() {
    let validator
    jest.isolateModules(() => {
        validator = require('../../src/utils/ssrf-validator')
    })
    return validator
}

function deadlineReason() {
    const reason = new Error('Request deadline exceeded')
    reason.safeMessage = 'Request timed out'
    return reason
}

const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
    pending = []
    calls = 0
    mockLookup = hangingLookup
})

afterEach(async () => {
    //settle whatever a test left hanging, so nothing outlives it
    for (const lookup of pending)
        lookup.resolve(publicAnswer)
    await flush()
})

describe('lookups in flight are capped so abandoned ones cannot fill the threadpool', () => {
    test('refuses a lookup beyond the cap at once, without echoing the host, while the ones in flight never answer', async () => {
        const {resolveAndValidate} = loadValidator()
        const held = [resolveAndValidate('http://first.example.com/'), resolveAndValidate('http://second.example.com/')]
        held.forEach(p => p.catch(() => {}))
        const started = Date.now()
        for (const name of ['third', 'fourth', 'fifth']) {
            const error = await resolveAndValidate(`http://${name}.example.com/`).then(() => null, e => e)
            expect(error).not.toBeNull()
            expect(error.safeMessage).toBe(capMessage)
            expect(error.message).not.toContain(name)
            expect(error.message).not.toContain('example')
        }
        expect(Date.now() - started).toBeLessThan(500)
        //the refused requests never reached the resolver, so the count is still the two it started with
        expect(calls).toBe(2)
    })

    test('frees a slot when an abandoned lookup settles late, not when its deadline fires', async () => {
        const {resolveAndValidate} = loadValidator()
        const controllers = [new AbortController(), new AbortController()]
        const abandoned = controllers.map((c, i) => resolveAndValidate(`http://slow${i}.example.com/`, {signal: c.signal}))
        for (const c of controllers)
            c.abort(deadlineReason())
        for (const request of abandoned)
            await expect(request).rejects.toThrow('Request deadline exceeded')
        //the deadline has given up on both, but each still holds a threadpool thread
        await expect(resolveAndValidate('http://third.example.com/')).rejects.toMatchObject({safeMessage: capMessage})
        expect(calls).toBe(2)
        //the resolver answers after the deadline, once with an address and once with a failure
        pending.shift().resolve(publicAnswer)
        pending.shift().reject(new Error('getaddrinfo ENOTFOUND'))
        await flush()
        //both slots are free again, and no more than that: a third lookup is still refused
        const fresh = [resolveAndValidate('http://fresh0.example.com/'), resolveAndValidate('http://fresh1.example.com/')]
        fresh.forEach(p => p.catch(() => {}))
        expect(calls).toBe(4)
        await expect(resolveAndValidate('http://fresh2.example.com/')).rejects.toMatchObject({safeMessage: capMessage})
        expect(calls).toBe(4)
    })

    test('leaves an ordinary fast lookup unaffected and releases its slot', async () => {
        const {resolveAndValidate} = loadValidator()
        mockLookup = () => {
            calls++
            return Promise.resolve(publicAnswer)
        }
        for (let i = 0; i < 20; i++) {
            const {resolvedIp} = await resolveAndValidate(`http://fast${i}.example.com/`, {signal: new AbortController().signal})
            expect(resolvedIp).toBe('93.184.216.34')
        }
        const pair = await Promise.all([resolveAndValidate('http://a.example.com/'), resolveAndValidate('http://b.example.com/')])
        expect(pair.map(r => r.resolvedIp)).toEqual(['93.184.216.34', '93.184.216.34'])
        expect(calls).toBe(22)
        //every one of those released its slot: two hanging lookups still fit, and only the third is refused
        mockLookup = hangingLookup
        const held = [resolveAndValidate('http://c.example.com/'), resolveAndValidate('http://d.example.com/')]
        held.forEach(p => p.catch(() => {}))
        expect(calls).toBe(24)
        await expect(resolveAndValidate('http://e.example.com/')).rejects.toMatchObject({safeMessage: capMessage})
    })
})

describe('an abort without a usable reason still reports a safe message', () => {
    test('a reason that is an error without a safeMessage is replaced by one that has it', async () => {
        const {resolveAndValidate} = loadValidator()
        const controller = new AbortController()
        controller.abort(new Error('plain cancellation'))
        const error = await resolveAndValidate('http://name.example.com/', {signal: controller.signal}).then(() => null, e => e)
        expect(error.safeMessage).toBe('Request timed out')
        expect(calls).toBe(0)
    })

    test('outside the jest sandbox, where the DOMException left by abort() is an Error, the error still has one', () => {
        //jest's Error is a different constructor from the one the DOMException comes from, so an `instanceof` check
        //passes in here for the wrong reason. Plain node is the realm production runs in; dns is stubbed there as well
        const validatorPath = path.join(__dirname, '..', '..', 'src', 'utils', 'ssrf-validator.js')
        const script = [
            'require(\'dns\').promises.lookup = () => Promise.reject(new Error(\'stubbed\'))',
            `const {resolveAndValidate} = require(${JSON.stringify(validatorPath)})`,
            'const controller = new AbortController()',
            'controller.abort()',
            'if (!(controller.signal.reason instanceof Error)) throw new Error(\'realm assumption failed\')',
            'resolveAndValidate(\'http://name.example.com/\', {signal: controller.signal})',
            '    .then(() => process.stdout.write(\'{}\'), e => process.stdout.write(JSON.stringify({safeMessage: e.safeMessage})))'
        ].join('\n')
        const output = execFileSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 10000})
        expect(JSON.parse(output).safeMessage).toBe('Request timed out')
    })
})
