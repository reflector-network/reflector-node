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
