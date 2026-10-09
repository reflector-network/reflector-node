const fs = require('fs')
const {Keypair, StrKey} = require('@stellar/stellar-sdk')

//the path of app.config.json, never the seed itself: a command-line argument is readable by every process in the
//container through /proc/<pid>/cmdline and ps
const configPath = process.argv[2]

if (!configPath)
    throw new Error('Path to app.config.json is required')
if (StrKey.isValidEd25519SecretSeed(configPath))
    throw new Error('Pass the path of app.config.json, not the secret key')

let config = null
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (err) {
    //a JSON.parse message can quote the text around the error, and in this file that text can be the seed
    throw new Error(err instanceof SyntaxError ? `${configPath} is not valid JSON` : err.message)
}
const secret = config?.secret
if (!secret)
    throw new Error('Secret key is not provided. Check app.config.json')

console.log(Keypair.fromSecret(secret).publicKey())
