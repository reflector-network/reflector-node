const fs = require('fs')
const {validateGatewayUrl, maxGatewayUrls, unbracketHost} = require('./ssrf-validator')

/**
 * @param {any} url - one entry of the list
 * @returns {string|null} the entry's host, or null when it has none that can be named
 */
function hostOf(url) {
    try {
        return unbracketHost(new URL(url).hostname) || null
    } catch (err) {
        return null
    }
}

/**
 * Describes one refused entry by its position and host only: a gateway url can carry a token in its path, query or user
 * information, and the output of the pre-flight is pasted into tickets and chats
 * @param {any} url - the refused entry
 * @param {number} index - its position in the list
 * @param {Error} err - the validator's refusal
 * @returns {string}
 */
function describeProblem(url, index, err) {
    let reason = String(err && err.message)
    if (typeof url === 'string' && url)
        reason = reason.split(url).join('<url>') //none of the validator's messages quotes the url; this keeps it so
    const host = hostOf(url)
    return host && !reason.includes(host) ? `urls[${index}]: ${reason} (host: ${host})` : `urls[${index}]: ${reason}`
}

/**
 * Checks a gateways.json the way SettingsManager.init reads it. 'none': no file, or its list is empty or
 * missing - the node routes directly. 'usable': at least one url passes validateGatewayUrl. 'unusable': anything else,
 * the state in which a node posts no webhooks and fetches no exchanges prices. The release pre-flight runs it over every
 * node's gateways.json with the new release's own rules. Like validateGatewayUrl it judges IP literals
 * only: a hostname that resolves to a private address passes here
 * @param {string|null} content - file content, null when the file does not exist
 * @returns {{state: string, problems: string[]}} problems names each rule the file or an entry breaks
 */
function checkGateways(content) {
    if (content === null)
        return {state: 'none', problems: []}
    let parsed = null
    try {
        parsed = JSON.parse(content.trim())
    } catch (err) {
        //the parser's message quotes the text around the error, which can be part of a gateway url and its token
        return {state: 'unusable', problems: ['gateways.json is not valid JSON']}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return {state: 'unusable', problems: ['gateways.json does not hold an object']}
    const {urls, challenge} = parsed
    if (urls === undefined || urls === null || (Array.isArray(urls) && urls.length === 0))
        return {state: 'none', problems: []}
    if (!Array.isArray(urls))
        return {state: 'unusable', problems: ['urls is not an array']}
    if (urls.length > maxGatewayUrls)
        return {state: 'unusable', problems: [`more than ${maxGatewayUrls} urls`]}
    if (typeof challenge !== 'string' || !challenge)
        return {state: 'unusable', problems: ['a non-empty list needs a string challenge']}
    const problems = []
    let usable = 0
    urls.forEach((url, index) => {
        try {
            validateGatewayUrl(url)
            usable++
        } catch (err) {
            problems.push(describeProblem(url, index, err))
        }
    })
    return {state: usable > 0 ? 'usable' : 'unusable', problems}
}

/**
 * The command line: node check-gateways.js [--missing-ok] <path to gateways.json>
 * @param {string[]} args - command-line arguments
 * @returns {number} exit code: 0 for no gateways or a fully usable list, 1 otherwise, 2 for a usage error
 */
function main(args) {
    const missingOk = args.includes('--missing-ok')
    const filePath = args.find(arg => arg !== '--missing-ok')
    if (!filePath) {
        console.error('usage: node check-gateways.js [--missing-ok] <path to gateways.json>')
        return 2
    }
    const exists = fs.existsSync(filePath)
    //a mistyped path must not pass the pre-flight as "no gateways configured"
    if (!missingOk && !exists) {
        console.error(`${filePath} does not exist; pass --missing-ok for a node that has no gateways.json`)
        return 1
    }
    let result = null
    try {
        result = checkGateways(exists ? fs.readFileSync(filePath, 'utf8') : null)
    } catch (err) {
        result = {state: 'unusable', problems: ['gateways.json cannot be read']}
    }
    console.log(JSON.stringify({file: filePath, ...result}, null, 2))
    //a partly rejected list fails the pre-flight too: it routes through fewer gateways than the operator configured
    return result.state === 'unusable' || result.problems.length > 0 ? 1 : 0
}

//exitCode rather than process.exit, so the printed result is flushed to a pipe before the process ends
if (require.main === module)
    process.exitCode = main(process.argv.slice(2))

module.exports = {checkGateways}
