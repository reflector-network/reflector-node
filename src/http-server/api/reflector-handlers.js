const container = require('../../domain/container')
const {forbidden} = require('../errors')
const {registerRoute} = require('../router')
const {validateSignature} = require('../signature-validator')
const NodeStatus = require('../../domain/node-status')
const logger = require('../../logger')

/**
 * @typedef {import('express').Express} Express
 */

function checkIfNodeIsReady() {
    if (container.settingsManager.nodeStatus !== NodeStatus.ready)
        throw forbidden('Reflector node is not initalized.')
}

function checkIfNodeIsInInit() {
    if (container.settingsManager.nodeStatus !== NodeStatus.init)
        throw forbidden('Reflector node is initalized already.')
}

module.exports = function (app) {
    registerRoute(app, 'get', '/', {}, () => {

        const info = {
            name: 'reflector',
            version: container.version,
            status: container.settingsManager.nodeStatus
        }
        if (container.settingsManager.appConfig?.publicKey)
            info.pubkey = container.settingsManager.appConfig.publicKey
        return info
    })
    registerRoute(app, 'get', '/config-requirements', {}, () => {
        checkIfNodeIsInInit()
        const {appConfig: config} = container.settingsManager
        const isDbConnectionRequired = !(config.dockerDbPassword || config.dbConnectionString)
        return {isDbConnectionRequired}
    })
    registerRoute(app, 'get', '/contract-settings/:oracleId', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsReady()
        return container.settingsManager.getContractSettingsForClient(req.params.oracleId)
    })
    registerRoute(app, 'get', '/statistics', {middleware: [validateSignature]}, () => {
        checkIfNodeIsReady()
        return container.statisticsManager.getStatistics()
    })
    registerRoute(app, 'get', '/config', {middleware: [validateSignature]}, () => {
        checkIfNodeIsReady()
        return container.settingsManager.getConfigForClient()
    })
    registerRoute(app, 'get', '/update/:oracleId', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsReady()
        return container.settingsManager.getPendingUpdate(req.params.oracleId)?.toPlainObject()
    })
    registerRoute(app, 'post', '/update/:oracleId', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsReady()
        container.settingsManager.setPendingUpdate(req.params.oracleId, req.body)
    })
    registerRoute(app, 'post', '/config', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsInInit()
        container.settingsManager.updateConfig(req.body)
    })
    registerRoute(app, 'post', '/trace', {middleware: [validateSignature]}, (req) => {
        logger.setTrace(req.body.isTraceEnabled)
    })
    registerRoute(app, 'post', '/addContract', {middleware: [validateSignature]}, (req) => {
        const {contract} = req.body
        container.settingsManager.addContract(contract)
    })
}