const {Keypair} = require('@stellar/stellar-sdk')

const secret = process.argv[2]

if (!secret) {
    throw new Error('Secret key is not provided. Check app.config.json')
}

const keypair = Keypair.fromSecret(secret)
console.log(keypair.publicKey())
