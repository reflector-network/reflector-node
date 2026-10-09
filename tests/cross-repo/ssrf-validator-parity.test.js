/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')

//node-orchestrator keeps its own copy of this validator (utils/ssrf-validator.js) for the gateway urls it relays and
//checks; the address and gateway rules of the two copies must stay byte-identical, or an address one side refuses is
//accepted by the other. Without the sibling checkout the suite fails unless
//SKIP_CROSS_REPO=1 is set
const {describeWithOrchestrator, orch} = require('./orchestrator-sibling')

const nodeCopy = path.resolve(__dirname, '../../src/utils/ssrf-validator.js')
const orchestratorCopy = orch('utils/ssrf-validator.js')

/**
 * @param {string} source - file text with LF line ends
 * @param {string} name - function name
 * @returns {string} the function from its declaration to the closing brace at column 0
 */
function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0)
        throw new Error(`function ${name} not found`)
    return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

/**
 * @param {string} source - file text
 * @param {string} name - constant name
 * @returns {string} the constant's initialiser
 */
function constantValue(source, name) {
    return source.match(new RegExp(`const ${name} = ([^\\s/]+)`))[1]
}

describeWithOrchestrator('the node and orchestrator ssrf validators share their address and gateway rules', ['utils/ssrf-validator.js'], () => {
    const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const node = read(nodeCopy)
    const orchestrator = read(orchestratorCopy)

    test.each(['isPrivateIPv4', 'toIPv6Bytes', 'isPrivateIPv6', 'isPrivateIP', 'unbracketHost', 'validateGatewayUrl', 'lookupWithin'])('%s is byte-identical', name => {
        expect(functionSource(node, name)).toBe(functionSource(orchestrator, name))
    })

    test.each(['maxGatewayUrls', 'maxGatewayUrlLength', 'maxLookupsInFlight'])('%s is the same', name => {
        expect(constantValue(node, name)).toBe(constantValue(orchestrator, name))
    })

    test('both copies refuse the IPv4-translated range by the address it carries', () => {
        const ours = require(nodeCopy)
        const theirs = require(orchestratorCopy)
        for (const address of ['::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', '::ffff:0:a00:1', '::ffff:0:808:808', '::ffff:7f00:1', '::7f00:1'])
            expect(ours.isPrivateIP(address)).toBe(theirs.isPrivateIP(address))
        expect(ours.isPrivateIP('::ffff:0:7f00:1')).toBe(true)
        expect(ours.isPrivateIP('::ffff:0:808:808')).toBe(false)
    })
})
