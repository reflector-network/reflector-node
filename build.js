const fs = require('fs')
const path = require('path')
const execSync = require('child_process').execSync

const srcDir = path.resolve(__dirname, 'src')
const distDir = path.resolve(__dirname, 'dist')
const distAppDir = path.resolve(distDir, 'app')

const foldersToIgnore = ['tests', 'home']

if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, {recursive: true})
}

fs.mkdirSync(distDir, {recursive: true})

function copyFolderRecursive(source, target) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, {recursive: true})
    }

    if (fs.lstatSync(source).isDirectory()) {
        for (const file of fs.readdirSync(source)) {
            const curSource = path.join(source, file)

            if (foldersToIgnore.some(folder => curSource.includes(path.join('src', folder)))) {
                continue
            }

            if (fs.lstatSync(curSource).isDirectory()) {
                copyFolderRecursive(curSource, path.join(target, file))
            } else {
                fs.copyFileSync(curSource, path.join(target, file))
            }
        }
    }
}

copyFolderRecursive(srcDir, distAppDir)

fs.copyFileSync(path.resolve(__dirname, 'package.json'), path.resolve(distDir, 'package.json'))

execSync('npm install --omit=dev', {cwd: distDir, stdio: 'inherit'})

console.log('Build completed successfully!')