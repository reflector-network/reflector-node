/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {Asset, compareStrings} = require('@reflector/reflector-shared')
const container = require('../../../src/domain/container')
const {normalizePriceDataFetchOptions} = require('../../../src/domain/prices/trades-manager')

const srcRoot = path.join(__dirname, '../../../src')

/**
 * @param {string} dir - directory to walk
 * @returns {string[]} absolute paths of every .js file below dir
 */
function collectSources(dir) {
    const found = []
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory())
            found.push(...collectSources(full))
        else if (entry.name.endsWith('.js'))
            found.push(full)
    }
    return found
}

describe('consensus ordering', () => {
    test('no locale-sensitive comparison anywhere under src', () => {
        const offenders = collectSources(srcRoot)
            .filter(file => /localeCompare|Intl\.Collator|toLocale/.test(fs.readFileSync(file, 'utf8')))
            .map(file => path.relative(srcRoot, file))

        expect(offenders).toEqual([])
    })

    test('compareStrings orders by code unit, not locale collation', () => {
        //code-unit: 'B' (U+0042) is 66, 'a' (U+0061) is 97, so 'B' sorts first.
        //en-locale collation is case-insensitive by base letter and would put 'a' first instead - a
        //comparator swapped back to String.prototype.localeCompare would fail these exact assertions.
        expect(compareStrings('B', 'a')).toBe(-1)
        expect(compareStrings('a', 'B')).toBe(1)
        expect(compareStrings('a', 'a')).toBe(0)
        expect('B'.localeCompare('a')).toBe(1) //the two comparators genuinely disagree on this pair
    })
})

describe('connector request options', () => {
    beforeEach(() => {
        container.settingsManager = {
            gateways: {urls: ['http://gateway-1', 'http://gateway-2']},
            getSimSource: () => undefined
        }
    })

    test('carries `from` in seconds and never a second name for the same value', () => {
        const options = normalizePriceDataFetchOptions(
            {name: 'forex', providers: ['ecb', 'nbp']},
            new Asset(2, 'USD'),
            [new Asset(2, 'EUR'), new Asset(2, 'GBP')],
            1_700_000_040,
            60,
            5
        )

        expect(options.from).toBe(1_700_000_040)
        expect(options.period).toBe(60)
        expect(options.count).toBe(5)
        expect(options.baseAsset).toBe('USD')
        expect(options.assets).toEqual(['EUR', 'GBP'])
        //reflector-fx-connector 3.1.0 reads `from`; the node must not also send `timestamp`, which would be a second
        //name for the same value and a second thing to keep in step
        expect('timestamp' in options).toBe(false)
        expect(options.options.sources).toEqual(['ecb', 'nbp'])
        expect(options.options.batchSize).toBe(2)
    })

    test('drops undefined options rather than sending them', () => {
        const options = normalizePriceDataFetchOptions(
            {name: 'exchanges', providers: undefined},
            new Asset(2, 'USD'),
            [new Asset(2, 'BTC')],
            1_700_000_040,
            60,
            1
        )

        expect('simSource' in options).toBe(false)
        expect('sources' in options.options).toBe(false)
    })

    test('never sends a poolGuards override; the stellar connector must fall back to its own default', () => {
        const options = normalizePriceDataFetchOptions(
            {name: 'pubnet', providers: undefined},
            new Asset(1, 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
            [new Asset(1, 'XLM')],
            1_700_000_040,
            60,
            1
        )

        expect('poolGuards' in options.options).toBe(false)
    })
})
