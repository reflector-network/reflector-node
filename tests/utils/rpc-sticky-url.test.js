/*eslint-disable no-undef */
const mockRpc = {failing: new Set(), requests: []}

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk')
    class Server {
        constructor(url) {
            this.url = url
            this.httpClient = {defaults: {}}
        }
    }
    return {...actual, rpc: {...actual.rpc, Server}}
})

const {makeServerRequest} = require('../../src/utils/rpc-helper')

const tenMinutes = 10 * 60 * 1000

/**
 * A request function whose url fails at once when it is in `failing`, as a hung url does once its deadline passed
 * @param {{url: string}} server - the server the helper built
 * @returns {Promise<string>}
 */
function answer(server) {
    mockRpc.requests.push(server.url)
    if (mockRpc.failing.has(server.url))
        return Promise.reject(new Error('timeout of 15000ms exceeded'))
    return Promise.resolve(server.url)
}

beforeEach(() => {
    mockRpc.failing = new Set()
    mockRpc.requests = []
})

//the preference is module state, so every test uses url lists of its own
describe('the rpc url that answered last is tried first', () => {
    test('a failing first url costs one request, not one per request', async () => {
        const urls = ['http://hung-a', 'http://good-a']
        mockRpc.failing.add('http://hung-a')

        expect(await makeServerRequest(urls, answer)).toBe('http://good-a')
        expect(await makeServerRequest(urls, answer)).toBe('http://good-a')

        expect(mockRpc.requests).toEqual(['http://hung-a', 'http://good-a', 'http://good-a'])
    })

    test('when the remembered url fails, the others are tried in configured order', async () => {
        const urls = ['http://first-b', 'http://second-b', 'http://third-b']
        mockRpc.failing.add('http://first-b')
        await makeServerRequest(urls, answer)

        mockRpc.failing = new Set(['http://second-b'])
        mockRpc.requests = []
        expect(await makeServerRequest(urls, answer)).toBe('http://first-b')
        expect(await makeServerRequest(urls, answer)).toBe('http://first-b')

        expect(mockRpc.requests).toEqual(['http://second-b', 'http://first-b', 'http://first-b'])
    })

    test('each configured url list keeps its own preference', async () => {
        mockRpc.failing.add('http://x1')
        await makeServerRequest(['http://x1', 'http://x2'], answer)
        await makeServerRequest(['http://y1', 'http://y2'], answer)
        await makeServerRequest(['http://x1', 'http://x2'], answer)

        expect(mockRpc.requests).toEqual(['http://x1', 'http://x2', 'http://y1', 'http://x2'])
    })

    test('a preference is dropped ten minutes after it was set, so the first url is tried again', async () => {
        const urls = ['http://primary-d', 'http://secondary-d']
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        try {
            mockRpc.failing.add('http://primary-d')
            await makeServerRequest(urls, answer)
            mockRpc.failing = new Set()
            now.mockReturnValue(1_000_000 + tenMinutes - 1)
            await makeServerRequest(urls, answer)
            now.mockReturnValue(1_000_000 + tenMinutes)
            await makeServerRequest(urls, answer)
            await makeServerRequest(urls, answer)
        } finally {
            now.mockRestore()
        }
        const expected = ['http://primary-d', 'http://secondary-d', 'http://secondary-d', 'http://primary-d', 'http://primary-d']
        expect(mockRpc.requests).toEqual(expected)
    })

    test('once a preference expires, a first url that still fails costs one more request, not one per request', async () => {
        const urls = ['http://primary-e', 'http://secondary-e']
        const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000)
        try {
            mockRpc.failing.add('http://primary-e')
            await makeServerRequest(urls, answer)
            now.mockReturnValue(2_000_000 + tenMinutes)
            await makeServerRequest(urls, answer)
            now.mockReturnValue(2_000_000 + tenMinutes + 1)
            await makeServerRequest(urls, answer)
        } finally {
            now.mockRestore()
        }
        expect(mockRpc.requests).toEqual([
            'http://primary-e', 'http://secondary-e', //the preference is set
            'http://primary-e', 'http://secondary-e', //it has expired: configured order, a fresh preference
            'http://secondary-e' //the fresh preference holds
        ])
    })

    test('a preference is not extended while the same url keeps answering', async () => {
        const urls = ['http://primary-f', 'http://secondary-f']
        const now = jest.spyOn(Date, 'now').mockReturnValue(3_000_000)
        try {
            mockRpc.failing.add('http://primary-f')
            await makeServerRequest(urls, answer)
            mockRpc.failing = new Set()
            for (const offset of [1, tenMinutes / 2, tenMinutes - 1]) {
                now.mockReturnValue(3_000_000 + offset)
                await makeServerRequest(urls, answer)
            }
            now.mockReturnValue(3_000_000 + tenMinutes)
            await makeServerRequest(urls, answer)
        } finally {
            now.mockRestore()
        }
        expect(mockRpc.requests).toEqual([
            'http://primary-f', 'http://secondary-f',
            'http://secondary-f', 'http://secondary-f', 'http://secondary-f',
            'http://primary-f'
        ])
    })
})

describe('a url list given as a Set or a string is accepted', () => {
    test('a Set of urls fails over like an array', async () => {
        const urls = new Set(['http://set-i-1', 'http://set-i-2'])
        mockRpc.failing.add('http://set-i-1')
        await makeServerRequest(urls, answer)
        mockRpc.failing.delete('http://set-i-1')
        mockRpc.requests = []

        await makeServerRequest(urls, answer)

        expect(mockRpc.requests).toEqual(['http://set-i-2'])
    })

    test('a single url given as a string is treated as a one-element list', async () => {
        const url = 'http://string-only-j'

        expect(await makeServerRequest(url, answer)).toBe(url)

        expect(mockRpc.requests).toEqual([url])
    })
})

//the node abstains on a read no url answers: the preference changes which url is asked first, never whether a request
//that fails everywhere still fails, after as many attempts as before
describe('a failed request fails as it did before the preference', () => {
    let warn

    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
        warn.mockRestore()
    })

    test('with a preference in place every url is still tried on each of the three attempts', async () => {
        const urls = ['http://one-g', 'http://two-g', 'http://three-g']
        mockRpc.failing.add('http://one-g')
        await makeServerRequest(urls, answer)
        mockRpc.failing = new Set(urls)
        mockRpc.requests = []

        const error = await makeServerRequest(urls, answer).catch(e => e)

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe('Failed to invoke RPC method on all provided URLs')
        const attempt = ['http://two-g', 'http://one-g', 'http://three-g']
        expect(mockRpc.requests).toEqual([...attempt, ...attempt, ...attempt])
        expect(error.cause.errAggr.map(({url}) => url)).toEqual(attempt)
        expect(error.cause.errAggr.map(({err}) => err.message)).toEqual(Array(3).fill('timeout of 15000ms exceeded'))
        expect(warn).toHaveBeenCalledTimes(2)
    })

    test('a url listed twice is still asked twice when it is the preferred one', async () => {
        const urls = ['http://dup-a', 'http://dup-b', 'http://dup-a']
        await makeServerRequest(urls, answer)
        mockRpc.failing = new Set(['http://dup-a', 'http://dup-b'])
        mockRpc.requests = []

        await expect(makeServerRequest(urls, answer)).rejects.toThrow('Failed to invoke RPC method on all provided URLs')

        expect(mockRpc.requests).toEqual([...urls, ...urls, ...urls])
    })

    test('a url listed twice keeps its second place when another url is preferred', async () => {
        const urls = ['http://dup2-a', 'http://dup2-b', 'http://dup2-a']
        mockRpc.failing.add('http://dup2-a')
        await makeServerRequest(urls, answer)
        mockRpc.failing = new Set(urls)
        mockRpc.requests = []

        await expect(makeServerRequest(urls, answer)).rejects.toThrow('Failed to invoke RPC method on all provided URLs')

        const attempt = ['http://dup2-b', 'http://dup2-a', 'http://dup2-a']
        expect(mockRpc.requests).toEqual([...attempt, ...attempt, ...attempt])
    })

    test('a failed request leaves the preference as it was', async () => {
        const urls = ['http://one-h', 'http://two-h']
        mockRpc.failing.add('http://one-h')
        await makeServerRequest(urls, answer)
        mockRpc.failing = new Set(urls)
        await expect(makeServerRequest(urls, answer)).rejects.toThrow('Failed to invoke RPC method on all provided URLs')
        mockRpc.failing = new Set()
        mockRpc.requests = []

        await makeServerRequest(urls, answer)

        expect(mockRpc.requests).toEqual(['http://two-h'])
    })

    test('no url at all still fails before any request', async () => {
        await expect(makeServerRequest([], answer)).rejects.toThrow('No soroban rpc urls provided')
        await expect(makeServerRequest(undefined, answer)).rejects.toThrow('No soroban rpc urls provided')
        expect(mockRpc.requests).toEqual([])
    })
})

describe('remembered url lists stay bounded', () => {
    /**
     * Sets a preference for the second url of a fresh list
     * @param {string} name - list name
     * @returns {Promise<string[]>} the list
     */
    async function preferSecond(name) {
        const urls = [`http://${name}-1`, `http://${name}-2`]
        mockRpc.failing.add(urls[0])
        await makeServerRequest(urls, answer)
        mockRpc.failing.delete(urls[0])
        return urls
    }

    test('the seventeenth list evicts the list that answered longest ago', async () => {
        const oldest = await preferSecond('lru-old')
        const second = await preferSecond('lru-second')
        for (let i = 0; i < 15; i++)
            await preferSecond(`lru-fill-${i}`)
        mockRpc.requests = []

        //the second list first: the oldest one answering would be remembered again and push the second one out
        await makeServerRequest(second, answer)
        await makeServerRequest(oldest, answer)

        //the second list kept its preference; the oldest one lost it and starts again at its first url
        expect(mockRpc.requests).toEqual(['http://lru-second-2', 'http://lru-old-1'])
    })

    test('a list that answers again becomes the most recent one', async () => {
        const kept = await preferSecond('mru-kept')
        const evicted = await preferSecond('mru-evicted')
        for (let i = 0; i < 14; i++)
            await preferSecond(`mru-fill-${i}`)
        await makeServerRequest(kept, answer)
        await preferSecond('mru-last')
        mockRpc.requests = []

        await makeServerRequest(evicted, answer)
        await makeServerRequest(kept, answer)

        expect(mockRpc.requests).toEqual(['http://mru-evicted-1', 'http://mru-kept-2'])
    })

    test('a preferred url that is not in the list asked for is never requested', async () => {
        //the key joins the urls with a line break, so these two lists share one key
        await preferSecond('collide')
        const joined = ['http://collide-1\nhttp://collide-2']
        mockRpc.requests = []

        await makeServerRequest(joined, answer)

        expect(mockRpc.requests).toEqual(joined)
    })

    test('an expired preference is dropped even when its preferred url is already first, so eviction targets the right list', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        try {
            //M: first url fails, second succeeds - the preference this test protects
            const mUrls = ['http://t16-m-1', 'http://t16-m-2']
            mockRpc.failing.add(mUrls[0])
            await makeServerRequest(mUrls, answer)
            mockRpc.failing.delete(mUrls[0])

            //L: its first url succeeds outright, so the preferred url is already first (index 0), timestamped long
            //before the ttl so it reads as expired against the "now" used below
            now.mockReturnValue(0)
            const lUrls = ['http://t16-l-1', 'http://t16-l-2']
            await makeServerRequest(lUrls, answer)
            now.mockReturnValue(1_000_000)

            //14 more lists bring the map to its 16-list capacity without touching M or L again
            for (let i = 0; i < 14; i++)
                await makeServerRequest([`http://t16-fill-${i}`], answer)

            //L's preference has expired and is deleted even though its preferred url is already first; a failing
            //request then leaves no entry for L
            mockRpc.failing.add(lUrls[0])
            mockRpc.failing.add(lUrls[1])
            await expect(makeServerRequest(lUrls, answer)).rejects.toThrow('Failed to invoke RPC method on all provided URLs')
            mockRpc.failing.delete(lUrls[0])
            mockRpc.failing.delete(lUrls[1])

            //a new, 17th list: with L's dead entry gone the map is back at 16, so nothing is evicted; with it still
            //there, this overflows the map and evicts the oldest live entry - M's
            await makeServerRequest(['http://t16-n'], answer)

            mockRpc.requests = []
            await makeServerRequest(mUrls, answer)
        } finally {
            now.mockRestore()
            warn.mockRestore()
        }
        expect(mockRpc.requests).toEqual(['http://t16-m-2'])
    })
})
