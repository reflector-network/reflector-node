#!/usr/bin/env node
//builds the pinned contract versions U8 flips between, from the reflector-contract checkout next to this repository:
//the released price oracle and the next release of it, and two builds of the next beam (no beam has been released yet)
const fs = require('fs')
const os = require('os')
const path = require('path')
const {createHash} = require('crypto')
const {execFileSync} = require('child_process')
const {settings} = require('./lib/env')

const pulse = {pkg: 'reflector-pulse-contract', file: 'reflector_pulse_contract.wasm'}
const beam = {pkg: 'reflector-beam-contract', file: 'reflector_beam_contract.wasm'}
const builds = [
    {name: 'oracle-v6.0.1', ref: 'v6.0.1', ...pulse},
    {name: 'oracle-8fca97d', ref: '8fca97d', ...pulse},
    {name: 'beam-09eff51', ref: '09eff51', ...beam},
    {name: 'beam-8fca97d', ref: '8fca97d', ...beam}
]
const outDir = path.join(__dirname, 'wasm')

fs.mkdirSync(outDir, {recursive: true})
for (const ref of new Set(builds.map(b => b.ref))) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), `reflector-contract-${ref}-`))
    execFileSync('git', ['-C', settings.contractRepo, 'archive', '--format=tar', `--output=${path.join(src, 'source.tar')}`, ref])
    //relative paths: GNU tar from Git Bash reads the drive letter of an absolute Windows path as a remote host
    execFileSync('tar', ['-xf', 'source.tar'], {cwd: src})
    for (const {name, pkg, file} of builds.filter(b => b.ref === ref)) {
        execFileSync('stellar', ['contract', 'build', '--package', pkg], {cwd: src, stdio: 'inherit'})
        const target = path.join(outDir, `${name}.wasm`)
        fs.copyFileSync(path.join(src, 'target', 'wasm32v1-none', 'release', file), target)
        console.log(`${path.basename(target)} ${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`)
    }
    fs.rmSync(src, {recursive: true, force: true})
}
