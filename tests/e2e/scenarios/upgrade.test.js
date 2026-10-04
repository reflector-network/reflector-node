/*eslint-disable no-undef */
const {targetBuild} = require('./upgrade')

const builds = [{hash: 'old'}, {hash: 'new'}]

test.each([
    ['old', 'new'],
    ['new', 'old'],
    ['other', 'new']
])('live %s upgrades to %s', (live, expected) => {
    expect(targetBuild(live, builds).hash).toBe(expected)
})

describe('the subscriptions round trip', () => {
    const {roundTrip} = require('./upgrade')
    const v1 = {hash: 'v1'}
    const latest = {hash: 'latest'}

    test('from the latest build it goes down to v1 and back', () => {
        expect(roundTrip('latest', v1, latest)).toEqual([v1, latest])
    })

    test('a contract left on v1 by an interrupted run only goes back to the latest build', () => {
        expect(roundTrip('v1', v1, latest)).toEqual([latest])
    })

    test('a contract on neither build goes through v1 to the latest build', () => {
        expect(roundTrip('other', v1, latest)).toEqual([v1, latest])
    })
})
