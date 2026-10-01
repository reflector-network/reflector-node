const fs = require('fs')
const path = require('path')
const {execSync} = require('child_process')

const directoriesToIgnore = ['tests', 'home', 'node_modules']

/**
 * @param {string} source - directory to copy
 * @param {string} target - destination directory
 */
function copyDirectoryRecursive(source, target) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, {recursive: true})
    }

    if (fs.lstatSync(source).isDirectory()) {
        for (const file of fs.readdirSync(source)) {
            const curSource = path.join(source, file)

            if (directoriesToIgnore.some(dir => curSource.includes(path.join('src', dir))))
                continue

            if (fs.lstatSync(curSource).isDirectory()) {
                copyDirectoryRecursive(curSource, path.join(target, file))
            } else {
                fs.copyFileSync(curSource, path.join(target, file))
            }
        }
    }
}

/**
 * Builds dist/ from a clean slate. The lockfile goes with package.json and `npm ci` installs exactly what it records,
 * so two builds of one commit install the same dependency trees and a moved git tag cannot change the image
 * @param {{rootDir: string, exec: function(string, object): void}} [options] - repository root and command runner
 */
function build({rootDir = __dirname, exec = execSync} = {}) {
    const srcDir = path.resolve(rootDir, 'src')
    const distDir = path.resolve(rootDir, 'dist')
    const lockfile = path.resolve(rootDir, 'package-lock.json')
    if (!fs.existsSync(lockfile))
        throw new Error('package-lock.json is required: the release build installs exactly what it records')

    if (fs.existsSync(distDir)) {
        fs.rmSync(distDir, {recursive: true})
    }
    fs.mkdirSync(distDir, {recursive: true})

    copyDirectoryRecursive(srcDir, path.resolve(distDir, 'app'))

    fs.copyFileSync(path.resolve(rootDir, 'package.json'), path.resolve(distDir, 'package.json'))
    fs.copyFileSync(lockfile, path.resolve(distDir, 'package-lock.json'))

    exec('npm ci --omit=dev', {cwd: distDir, stdio: 'inherit'})
}

if (require.main === module) {
    build()
    console.log('Build completed successfully!')
}

module.exports = {build}
