const path = require('path')
const fs = require('fs')
const {toJson} = require('./chain')

const reportsDir = path.resolve(__dirname, '..', 'reports')

function minutes(ms) {
    return `${(ms / 60000).toFixed(1)} min`
}

function describeTx(tx) {
    const calls = tx.calls.map(c => c.fn).join(', ') || 'set_options'
    return `- tx ${tx.hash} ${tx.successful ? 'ok' : 'FAILED'}: ${calls}; signed by ${tx.signers.map(s => s.slice(0, 8)).join(', ')}`
}

/**
 * @param {object[]} results - scenario results
 * @param {{startedAt: number, finishedAt: number, aborted: boolean, image: string}} meta - run facts
 * @returns {string}
 */
function renderMarkdown(results, meta) {
    const lines = [
        `# Cluster end-to-end run ${new Date(meta.startedAt).toISOString()}`,
        '',
        `Image: ${meta.image}. Duration: ${minutes(meta.finishedAt - meta.startedAt)}.${meta.aborted ? ' **Run stopped early.**' : ''}`,
        '',
        '| ID | Scenario | Result | Time | Note |',
        '|---|---|---|---|---|',
        ...results.map(r => `| ${r.id} | ${r.title} | ${r.status} | ${minutes(r.durationMs)} | ${(r.reason || '').replace(/\|/g, '/')} |`),
        ''
    ]
    for (const r of results) {
        if (!r.observed.length && !r.diagnostics && !r.healthAfter && !r.restoreError && !r.environment)
            continue
        lines.push(`## ${r.id} ${r.title}`, '')
        for (const tx of r.observed)
            lines.push(describeTx(tx))
        if (r.restoreError)
            lines.push(`- restore failed: ${r.restoreError}`)
        if (r.healthAfter)
            lines.push(`- unhealthy afterwards: ${r.healthAfter.join('; ')}`)
        for (const note of r.environment || [])
            lines.push(`- ${note}`)
        if (r.diagnostics)
            lines.push('', '```json', JSON.stringify(JSON.parse(toJson(r.diagnostics)), null, 2), '```')
        lines.push('')
    }
    return lines.join('\n')
}

function writeReport(results, meta) {
    fs.mkdirSync(reportsDir, {recursive: true})
    const stamp = new Date(meta.startedAt).toISOString().replace(/[:.]/g, '-')
    const md = path.join(reportsDir, `${stamp}.md`)
    const json = path.join(reportsDir, `${stamp}.json`)
    fs.writeFileSync(md, renderMarkdown(results, meta), 'utf8')
    fs.writeFileSync(json, toJson({meta, results}), 'utf8')
    return {md, json}
}

module.exports = {renderMarkdown, writeReport}
