const fs = require('fs')
const ChannelTypes = require('../channels/channel-types')
const container = require('../../domain/container')
const logger = require('../../logger')
const nonceManager = require('../nonce-manager')
const BaseHandler = require('./base-handler')
const {verifyControlMessage} = require('./control-message-auth')

//node-orchestrator relays the answer as one frame and caps node frames at 4 MiB. A log rotates at 2 MB, but a
//log of JSON lines about doubles when escaped for the wire, so the answer keeps the newest lines within this budget of
//escaped text
const maxAnswerBytes = 768 * 1024

//a log file name as the logger and its rotation write them (combined.log, 20260924-0000-01-combined.log): no separator,
//and no leading dot, so '.', '..' and hidden files are refused before any file system call
const logFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * @param {string} text - log file content
 * @returns {{logFile: string, truncated: boolean}} the newest whole lines whose escaped form fits the budget
 */
function tailWithinBudget(text) {
    let size = Buffer.byteLength(JSON.stringify(text))
    if (size <= maxAnswerBytes)
        return {logFile: text, truncated: false}
    let tail = text
    //keep the share of characters the budget allows; escaping is uneven, so repeat until the escaped tail fits. Every
    //round keeps strictly fewer characters, so the loop ends
    while (size > maxAnswerBytes) {
        tail = tail.slice(tail.length - Math.floor(tail.length * maxAnswerBytes / size))
        size = Buffer.byteLength(JSON.stringify(tail))
    }
    const lineStart = tail.indexOf('\n')
    return {logFile: lineStart >= 0 ? tail.slice(lineStart + 1) : tail, truncated: true}
}

class LogFileRequestHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.ORCHESTRATOR]

    allowAnonymous = true

    handle(_, message) {
        const logFileName = message?.data?.logFileName
        if (typeof logFileName !== 'string' || !logFileNamePattern.test(logFileName))
            throw new Error('Log file name is invalid')
        //the operator signed the route logs/<file>; the bare name beside the payload must be that same file
        verifyControlMessage(message, nonceManager.nonceTypes.LOG_FILE, `logs/${logFileName}`, {method: 'GET'})
        let content = null
        try {
            content = fs.readFileSync(`${container.homeDir}/logs/${logFileName}`).toString().trim()
        } catch (err) {
            //the file system error names the node's home directory, which is the node's business: the requester gets a
            //fixed message and the detail stays in this node's log
            logger.warn({msg: 'Requested log file cannot be read', logFileName, err: err.message})
            throw new Error('Log file cannot be read')
        }
        return tailWithinBudget(content)
    }
}

module.exports = LogFileRequestHandler
