/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const {execFileSync} = require('child_process')

//The cross-repository suites run node-orchestrator's own code from a sibling checkout. Without it they fail rather than
//skip: a lone clone cannot show that the two repositories agree, and a skipped suite reads as green. SKIP_CROSS_REPO=1
//skips them on purpose, checkout or not, and says so on every run. A suite that runs prints the orchestrator commit it
//ran against
const orchestratorDir = path.resolve(__dirname, '../../../node-orchestrator')
const skipRequested = process.env.SKIP_CROSS_REPO === '1'

/**
 * @param {string} rel - path inside the node-orchestrator checkout
 * @returns {string} absolute path
 */
function orch(rel) {
    return path.join(orchestratorDir, rel)
}

/**
 * @returns {string} the commit the sibling checkout is at, marked when its working tree has uncommitted changes
 */
function orchestratorRevision() {
    try {
        const head = execFileSync('git', ['-C', orchestratorDir, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
        const dirty = execFileSync('git', ['-C', orchestratorDir, 'status', '--porcelain', '--untracked-files=no'], {encoding: 'utf8'}).trim()
        return dirty ? `${head} with uncommitted changes` : head
    } catch (err) {
        return `unknown (${err.message.split('\n')[0]})`
    }
}

/**
 * Writes past jest's console capture, which drops the output of passing suites in a non-verbose run of several files
 * @param {string} line - text to report
 */
function report(line) {
    process.stderr.write(`[cross-repo] ${line}\n`)
}

/**
 * Declares a suite that needs the node-orchestrator checkout beside this repository. The body runs only when the suite
 * does: it may read the checkout while tests are collected
 * @param {string} name - suite name
 * @param {string[]} required - paths inside the checkout the suite loads
 * @param {function} fn - suite body, as for describe
 */
function describeWithOrchestrator(name, required, fn) {
    if (skipRequested) {
        report(`SKIPPED because SKIP_CROSS_REPO=1: ${name}. Parity with node-orchestrator is not shown`)
        describe.skip(name, () => {
            test('parity with node-orchestrator (skipped on purpose: SKIP_CROSS_REPO=1)', () => {})
        })
        return
    }
    const missing = required.filter(rel => !fs.existsSync(orch(rel)))
    if (!missing.length) {
        report(`${name}: node-orchestrator at ${orchestratorDir}, commit ${orchestratorRevision()}`)
        describe(name, fn)
        return
    }
    const reason = `node-orchestrator is not checked out at ${orchestratorDir} (missing ${missing.join(', ')}); the parity cannot be shown`
    describe(name, () => {
        test('the node-orchestrator checkout is present beside this repository (set SKIP_CROSS_REPO=1 to skip on purpose)', () => {
            throw new Error(reason)
        })
    })
}

module.exports = {describeWithOrchestrator, orch, orchestratorDir}
