const fs = require('fs')
const path = require('path')
const {rpc, Keypair} = require('@stellar/stellar-sdk')
const env = require('../lib/env')
const flow = require('../lib/flow')
const {contractOf, mutations} = require('../lib/config')
const {deployContract, generateContractConfig, updateAdminToMultiSigAccount} = require('../../cluster/utils')

const oracleWasm = path.join(__dirname, '..', '..', 'cluster', 'reflector_oracle.wasm')
const contractsFile = env.stateFile('e2e-contracts.json')

module.exports = [
    {
        id: 'L1',
        title: 'Add a contract',
        timeoutMs: 40 * 60000,
        async requires(ctx) {
            if (!fs.existsSync(oracleWasm))
                return `missing ${oracleWasm}`
            return contractOf((await flow.current(ctx)).raw, 'oracle', 'exchanges') ? null : 'no exchanges oracle to copy'
        },
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const server = new rpc.Server(env.settings.sorobanRpc[0])
            const deployer = Keypair.random()
            const admin = Keypair.random()
            await ctx.chain.fundAccount(deployer.publicKey())
            await ctx.chain.fundAccount(admin.publicKey())
            await updateAdminToMultiSigAccount(server, admin, Object.keys(raw.nodes), 'testnet')
            const contractId = await deployContract(server, deployer.secret(), 'oracle', `e2e-${Date.now()}`, 'testnet')
            const template = contractOf(raw, 'oracle', 'exchanges')
            const contract = {
                ...generateContractConfig({admin: admin.publicKey(), contractId, contractType: 'oracle', dataSource: 'exchanges'}),
                baseAsset: template.baseAsset,
                assets: template.assets.slice(0, 3)
            }
            env.writeJson(contractsFile, [...env.readJson(contractsFile, []), contractId])
            const result = await flow.applyChange(ctx, r => mutations.addContract(r, contract), {expect: null})
            //the new runner catches up with ticks whose deadline already passed, like a node that just started
            ctx.clusterStarts = [...(ctx.clusterStarts || []), result.switchTime]
            await ctx.wait(async () => {
                const state = await ctx.chain.contractState(contractId)
                return state.isInitialized && state.lastTimestamp > 0
            }, {timeout: 2 * contract.timeframe + 5 * 60000, every: 15000, describe: 'the new oracle to be initialised and updated'})
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'L2',
        title: 'Remove a contract',
        async requires(ctx) {
            const {raw} = await flow.current(ctx)
            return env.readJson(contractsFile, []).some(id => raw.contracts[id]) ? null : 'no contract added by L1 in the config'
        },
        async run(ctx) {
            const {raw} = await flow.current(ctx)
            const contractId = env.readJson(contractsFile, []).find(id => raw.contracts[id])
            const timeframe = raw.contracts[contractId].timeframe
            await flow.applyChange(ctx, r => mutations.removeContract(r, contractId), {expect: null})
            const before = (await ctx.chain.contractState(contractId)).lastTimestamp
            await ctx.sleep(timeframe + 120000)
            const after = (await ctx.chain.contractState(contractId)).lastTimestamp
            if (after !== before)
                throw new Error(`The removed oracle was still updated (${before} -> ${after})`)
            env.writeJson(contractsFile, env.readJson(contractsFile, []).filter(id => id !== contractId))
        },
        restore: ctx => flow.withdraw(ctx)
    },
    {
        id: 'L3',
        title: 'Price heartbeat and asset threshold',
        async requires(ctx) {
            return contractOf((await flow.current(ctx)).raw, 'oracle_beam') ? null : 'no beam contract'
        },
        async run(ctx) {
            const beam = contractOf((await flow.current(ctx)).raw, 'oracle_beam')
            await flow.applyChange(ctx, r => mutations.toggleThreshold(mutations.toggleHeartbeat(r), beam.contractId), {expect: null})
        },
        restore: ctx => flow.withdraw(ctx)
    }
]
