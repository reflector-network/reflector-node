/*eslint-disable no-undef */
const {ContractTypes} = require('@reflector/reflector-shared')
const OracleRunner = require('../../../src/domain/runners/oracle-runner')

const CONTRACT_ID = 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN'
const TIMEFRAME_5M = 5 * 60 * 1000
const HEARTBEAT_2H = 2 * 60 * 60 * 1000
const MAX_CACHE_TIMEFRAMES = 255
const CACHE_MAX_AGE_MS = MAX_CACHE_TIMEFRAMES * TIMEFRAME_5M

const ASSET_COUNT = 10

function asset(code, threshold = 0) {
    return {code, threshold}
}

function makeAssets(count = ASSET_COUNT) {
    return Array(count).fill(null).map((_, i) => asset(`A${i}`))
}

/**
 * Builds an OracleRunner with __loadPriceUpdateHistory stubbed, so tests
 * don't touch the RPC/container layer. Cache state is populated directly.
 * @param {Object} [opts]
 * @param {string} [opts.type] Contract type. Defaults to ORACLE_BEAM.
 * @param {Array<[number, bigint[]]>} [opts.cache] Initial cache entries.
 * @returns {OracleRunner}
 */
function makeRunner({type = ContractTypes.ORACLE_BEAM, cache = []} = {}) {
    const runner = new OracleRunner(CONTRACT_ID, type)
    runner.__loadPriceUpdateHistory = async () => {}
    for (const [ts, prices] of cache)
        runner.__pricesCache.set(ts, prices)
    return runner
}

describe('OracleRunner', () => {
    describe('__contractType', () => {
        test('returns the type passed to the constructor', () => {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
            expect(runner.__contractType).toBe(ContractTypes.ORACLE_BEAM)
        })

        test('falls back to ORACLE when no type is provided', () => {
            const runner = new OracleRunner(CONTRACT_ID)
            expect(runner.__contractType).toBe(ContractTypes.ORACLE)
        })
    })

    describe('constructor', () => {
        test('throws if contractId is missing', () => {
            expect(() => new OracleRunner()).toThrow(/contractId is required/)
        })
    })

    describe('__delay', () => {
        test('is 20 seconds — gives price-runner gossip time to land before the oracle tick', () => {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE)
            expect(runner.__delay).toBe(20_000)
        })
    })

    describe('__getNextTimestamp', () => {
        //`__getNextTimestamp(ts) = ts + min(60s, timeframe)`
        test('advances by 1 minute when timeframe > 1 minutes', () => {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
            //__timeframe reads from the contract config (container-backed).
            //Override it so this test stays hermetic.
            Object.defineProperty(runner, '__timeframe', {value: TIMEFRAME_5M})
            const t = 1_000_000_000_000
            expect(runner.__getNextTimestamp(t)).toBe(t + 60 * 1000)
        })
    })

    describe('__getPricesToUpdate', () => {
        describe('for ORACLE type', () => {
            test('returns prices unchanged (no heartbeat or threshold logic)', async () => {
                const runner = makeRunner({type: ContractTypes.ORACLE})
                const input = Array(ASSET_COUNT).fill(0n)
                input[0] = 42n
                const out = await runner.__getPricesToUpdate(
                    input, 1_000_000_000_000, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                )
                expect(out).toBe(input) //same reference — no transformation
                expect(out[0]).toBe(42n)
            })
        })

        describe('for ORACLE_BEAM type', () => {
            describe('heartbeat detection', () => {
                test('empty cache → heartbeat update', async () => {
                    const runner = makeRunner({cache: []})
                    const prices = Array(ASSET_COUNT).fill(0n)
                    prices[0] = 100n
                    const out = await runner.__getPricesToUpdate(
                        prices, 2 * HEARTBEAT_2H, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    //Heartbeat path keeps the non-zero current price; zero slots fall back to 0n.
                    expect(out[0]).toBe(100n)
                    for (let i = 1; i < ASSET_COUNT; i++)
                        expect(out[i]).toBe(0n)
                })

                test('most-recent cached entry before heartbeat boundary → heartbeat fires', async () => {
                    const boundary = 2 * HEARTBEAT_2H
                    const tickBeforeBoundary = boundary - TIMEFRAME_5M
                    const cached = Array(ASSET_COUNT).fill(0n)
                    cached[3] = 555n
                    const runner = makeRunner({cache: [[tickBeforeBoundary, cached]]})

                    const current = Array(ASSET_COUNT).fill(0n)
                    const out = await runner.__getPricesToUpdate(
                        current, boundary, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    //heartbeat fill-in pulls cached price for assets with no current price
                    expect(out[3]).toBe(555n)
                })

                test('most-recent cached entry at or after boundary → NOT a heartbeat', async () => {
                    const boundary = 2 * HEARTBEAT_2H
                    const cached = Array(ASSET_COUNT).fill(0n)
                    cached[3] = 555n
                    const runner = makeRunner({cache: [[boundary, cached]]})

                    const current = Array(ASSET_COUNT).fill(0n)
                    //Tick one timeframe past the boundary.
                    const out = await runner.__getPricesToUpdate(
                        current, boundary + TIMEFRAME_5M, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    //Non-heartbeat branch: price is 0n so `continue` — no fill-in applied.
                    expect(out[3]).toBe(0n)
                })

                test('heartbeat retries on every tick while there is a gap past the boundary', async () => {
                    //Gap scenario: heartbeat tick failed; no new entry landed. The next
                    //worker tick (not on the boundary) must still fire as a heartbeat
                    //so the cluster catches up instead of waiting a full heartbeat window.
                    const boundary = 2 * HEARTBEAT_2H
                    const tickBeforeBoundary = boundary - TIMEFRAME_5M
                    const cached = Array(ASSET_COUNT).fill(0n)
                    cached[3] = 555n
                    const runner = makeRunner({cache: [[tickBeforeBoundary, cached]]})

                    const current = Array(ASSET_COUNT).fill(0n)
                    const out = await runner.__getPricesToUpdate(
                        current, boundary + TIMEFRAME_5M, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    expect(out[3]).toBe(555n)
                })
            })

            describe('heartbeat fill-in', () => {
                test('keeps the current price when it is non-zero', async () => {
                    const runner = makeRunner({cache: []})
                    const prices = Array(ASSET_COUNT).fill(0n)
                    prices[2] = 777n
                    const out = await runner.__getPricesToUpdate(
                        prices, 2 * HEARTBEAT_2H, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    expect(out[2]).toBe(777n)
                })

                test('falls back to 0n (not undefined) when no cached value exists', async () => {
                    const runner = makeRunner({cache: []})
                    const prices = Array(ASSET_COUNT).fill(0n)
                    const out = await runner.__getPricesToUpdate(
                        prices, 2 * HEARTBEAT_2H, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    //The `price !== 0n` filter in __workerFn depends on this — without
                    //the 0n fallback, undefined would leak through as "non-zero".
                    for (const p of out)
                        expect(typeof p).toBe('bigint')
                })

                test('pulls the most recent non-zero cached price across entries', async () => {
                    const boundary = 2 * HEARTBEAT_2H
                    const olderPrices = Array(ASSET_COUNT).fill(0n)
                    olderPrices[1] = 100n
                    const newerPrices = Array(ASSET_COUNT).fill(0n)
                    newerPrices[1] = 200n //most recent value for asset 1
                    const runner = makeRunner({
                        cache: [
                            [boundary - 2 * TIMEFRAME_5M, olderPrices],
                            [boundary - TIMEFRAME_5M, newerPrices]
                        ]
                    })
                    const current = Array(ASSET_COUNT).fill(0n)
                    const out = await runner.__getPricesToUpdate(
                        current, boundary, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    expect(out[1]).toBe(200n)
                })

                test('falls back to older cached entries when the newest has zero at that index', async () => {
                    const boundary = 2 * HEARTBEAT_2H
                    const olderPrices = Array(ASSET_COUNT).fill(0n)
                    olderPrices[1] = 100n
                    const newerPrices = Array(ASSET_COUNT).fill(0n) //asset 1 is zero here
                    const runner = makeRunner({
                        cache: [
                            [boundary - 2 * TIMEFRAME_5M, olderPrices],
                            [boundary - TIMEFRAME_5M, newerPrices]
                        ]
                    })
                    const current = Array(ASSET_COUNT).fill(0n)
                    const out = await runner.__getPricesToUpdate(
                        current, boundary, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                    )
                    expect(out[1]).toBe(100n)
                })
            })

            describe('non-heartbeat threshold gating', () => {
                //Non-heartbeat tick: last cached entry is AT the boundary, worker tick is past.
                const boundary = 2 * HEARTBEAT_2H
                const nonHeartbeatTick = boundary + TIMEFRAME_5M

                test('zeroes out prices whose diff vs last cached is below threshold', async () => {
                    const cached = Array(ASSET_COUNT).fill(0n)
                    cached[0] = 1_000_000_000n
                    const runner = makeRunner({cache: [[boundary, cached]]})

                    const current = Array(ASSET_COUNT).fill(0n)
                    current[0] = 1_000_000_001n //1 ppb diff
                    const assets = makeAssets()
                    assets[0] = asset('A0', 10_000_000) //large threshold

                    const out = await runner.__getPricesToUpdate(
                        current, nonHeartbeatTick, HEARTBEAT_2H, TIMEFRAME_5M, assets
                    )
                    expect(out[0]).toBe(0n)
                })

                test('keeps prices whose diff vs last cached exceeds threshold', async () => {
                    const cached = Array(ASSET_COUNT).fill(0n)
                    cached[0] = 1_000_000_000n
                    const runner = makeRunner({cache: [[boundary, cached]]})

                    const current = Array(ASSET_COUNT).fill(0n)
                    current[0] = 2_000_000_000n //100% diff
                    const assets = makeAssets()
                    assets[0] = asset('A0', 1) //tiny threshold

                    const out = await runner.__getPricesToUpdate(
                        current, nonHeartbeatTick, HEARTBEAT_2H, TIMEFRAME_5M, assets
                    )
                    expect(out[0]).toBe(2_000_000_000n)
                })

                test('skips assets with no current price (leaves them as 0n)', async () => {
                    const cached = Array(ASSET_COUNT).fill(0n)
                    cached[0] = 1_000_000_000n
                    const runner = makeRunner({cache: [[boundary, cached]]})

                    const current = Array(ASSET_COUNT).fill(0n) //asset 0 absent
                    const assets = makeAssets()
                    assets[0] = asset('A0', 1)

                    const out = await runner.__getPricesToUpdate(
                        current, nonHeartbeatTick, HEARTBEAT_2H, TIMEFRAME_5M, assets
                    )
                    expect(out[0]).toBe(0n)
                })

                test('skips assets with no cached last price (keeps current value)', async () => {
                    //Cache is at boundary but asset 0 slot is 0n → no previous price to compare.
                    const cached = Array(ASSET_COUNT).fill(0n)
                    const runner = makeRunner({cache: [[boundary, cached]]})

                    const current = Array(ASSET_COUNT).fill(0n)
                    current[0] = 42n
                    const assets = makeAssets()
                    assets[0] = asset('A0', 10_000_000) //any threshold; won't apply

                    const out = await runner.__getPricesToUpdate(
                        current, nonHeartbeatTick, HEARTBEAT_2H, TIMEFRAME_5M, assets
                    )
                    expect(out[0]).toBe(42n)
                })
            })

            test('skips inactive (null) assets', async () => {
                const runner = makeRunner({cache: []})
                const prices = Array(ASSET_COUNT).fill(0n)
                prices[0] = 42n
                const assets = makeAssets()
                assets[0] = null //inactive
                const out = await runner.__getPricesToUpdate(
                    prices, 2 * HEARTBEAT_2H, HEARTBEAT_2H, TIMEFRAME_5M, assets
                )
                //Inactive asset is left untouched (the original non-zero carries through).
                expect(out[0]).toBe(42n)
            })

            test('nodes with matching cache state produce identical output (deterministic across cluster)', async () => {
                const cache = [[2 * HEARTBEAT_2H - TIMEFRAME_5M, Array(ASSET_COUNT).fill(0n)]]
                cache[0][1][5] = 999n
                const nodeA = makeRunner({cache: [[cache[0][0], [...cache[0][1]]]]})
                const nodeB = makeRunner({cache: [[cache[0][0], [...cache[0][1]]]]})

                const current = Array(ASSET_COUNT).fill(0n)
                const outA = await nodeA.__getPricesToUpdate(
                    [...current], 2 * HEARTBEAT_2H, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                )
                const outB = await nodeB.__getPricesToUpdate(
                    [...current], 2 * HEARTBEAT_2H, HEARTBEAT_2H, TIMEFRAME_5M, makeAssets()
                )
                expect(outA).toEqual(outB)
            })
        })
    })

    describe('__loadPriceUpdateHistory', () => {
        /**
         * Runs the load/evict pass with the RPC path short-circuited. The
         * helper swallows the URL error internally, so the eviction step
         * still runs over an empty entries map — which is the only pass
         * these tests exercise.
         * @param {OracleRunner} runner
         * @param {number} timestamp
         * @param {number} timeframe
         * @returns {Promise<void>}
         */
        async function runEviction(runner, timestamp, timeframe) {
            const container = require('../../../src/domain/container')
            const originalSettings = container.settingsManager
            container.settingsManager = {
                getBlockchainConnectorSettings: () => ({sorobanRpc: ['noop']})
            }
            const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
            try {
                await runner.__loadPriceUpdateHistory(timestamp, timeframe)
            } finally {
                container.settingsManager = originalSettings
                errSpy.mockRestore()
            }
        }

        test('evicts entries older than MAX_PRICES_CACHE_SIZE timeframes', async () => {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
            const now = 10_000_000_000
            runner.__pricesCache.set(now - CACHE_MAX_AGE_MS - TIMEFRAME_5M, []) //just outside
            runner.__pricesCache.set(now - CACHE_MAX_AGE_MS + TIMEFRAME_5M, []) //just inside
            runner.__pricesCache.set(now - TIMEFRAME_5M, []) //recent

            await runEviction(runner, now, TIMEFRAME_5M)

            const keys = [...runner.__pricesCache.keys()].sort((a, b) => a - b)
            expect(keys).toEqual([
                now - CACHE_MAX_AGE_MS + TIMEFRAME_5M,
                now - TIMEFRAME_5M
            ])
        })

        test('keeps entries exactly on the age boundary', async () => {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
            const now = 10_000_000_000
            runner.__pricesCache.set(now - CACHE_MAX_AGE_MS, []) //exactly at the edge

            await runEviction(runner, now, TIMEFRAME_5M)

            expect(runner.__pricesCache.has(now - CACHE_MAX_AGE_MS)).toBe(true)
        })

        test('fully clears cache when every entry is older than the age window', async () => {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
            const now = 10_000_000_000
            runner.__pricesCache.set(now - 10 * CACHE_MAX_AGE_MS, [])
            runner.__pricesCache.set(now - 5 * CACHE_MAX_AGE_MS, [])

            await runEviction(runner, now, TIMEFRAME_5M)

            expect(runner.__pricesCache.size).toBe(0)
        })

        test('leaves a fully-fresh cache untouched', async () => {
            const runner = new OracleRunner(CONTRACT_ID, ContractTypes.ORACLE_BEAM)
            const now = 10_000_000_000
            runner.__pricesCache.set(now - TIMEFRAME_5M, [])
            runner.__pricesCache.set(now - 2 * TIMEFRAME_5M, [])

            await runEviction(runner, now, TIMEFRAME_5M)

            expect(runner.__pricesCache.size).toBe(2)
        })
    })
})
