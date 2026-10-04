#!/usr/bin/env node
//builds the pinned contract versions U8 flips between, from the contract checkouts next to this repository: the
//released price oracle and the next release of it, two builds of the next beam (no beam has been released yet) and the
//first release of the subscriptions contract. Names given on the command line rebuild only those
const fs = require('fs')
const os = require('os')
const path = require('path')
const {createHash} = require('crypto')
const {execFileSync} = require('child_process')
const {settings} = require('./lib/env')

const pulse = {repo: settings.contractRepo, pkg: 'reflector-pulse-contract', file: 'reflector_pulse_contract.wasm'}
const beam = {repo: settings.contractRepo, pkg: 'reflector-beam-contract', file: 'reflector_beam_contract.wasm'}
const subscriptions = {repo: settings.subscriptionContractRepo, pkg: 'reflector-subscriptions', file: 'reflector_subscriptions.wasm'}
const only = process.argv.slice(2)
const builds = [
    {name: 'oracle-v6.0.1', ref: 'v6.0.1', ...pulse},
    {name: 'oracle-8fca97d', ref: '8fca97d', ...pulse},
    {name: 'beam-09eff51', ref: '09eff51', ...beam},
    {name: 'beam-8fca97d', ref: '8fca97d', ...beam},
    {name: 'subscriptions-v1.0.0', ref: 'v1.0.0', ...subscriptions}
].filter(b => !only.length || only.includes(b.name))
const outDir = path.join(__dirname, 'wasm')

fs.mkdirSync(outDir, {recursive: true})
for (const {repo, ref} of [...new Map(builds.map(b => [`${b.repo}@${b.ref}`, b])).values()]) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), `${path.basename(repo)}-${ref}-`))
    execFileSync('git', ['-C', repo, 'archive', '--format=tar', `--output=${path.join(src, 'source.tar')}`, ref])
    //relative paths: GNU tar from Git Bash reads the drive letter of an absolute Windows path as a remote host
    execFileSync('tar', ['-xf', 'source.tar'], {cwd: src})
    for (const {name, pkg, file} of builds.filter(b => b.repo === repo && b.ref === ref)) {
        execFileSync('stellar', ['contract', 'build', '--package', pkg], {cwd: src, stdio: 'inherit'})
        const target = path.join(outDir, `${name}.wasm`)
        fs.copyFileSync(path.join(src, 'target', 'wasm32v1-none', 'release', file), target)
        console.log(`${path.basename(target)} ${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`)
    }
    fs.rmSync(src, {recursive: true, force: true})
}
