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
        if (container.settingsManager.config?.publicKey)
            info.pubkey = container.settingsManager.config.publicKey
        return info
    })
    registerRoute(app, 'get', '/config-requirements', {}, () => {
        checkIfNodeIsInInit()
        const {config} = container.settingsManager
        const isDbConnectionRequired = !(config.dockerDbPassword || config.dbConnectionString)
        return {isDbConnectionRequired}
    })
    registerRoute(app, 'get', '/contract-settings', {middleware: [validateSignature]}, () => {
        checkIfNodeIsReady()
        return container.settingsManager.getContractSettingsForClient()
    })
    registerRoute(app, 'get', '/statistics', {middleware: [validateSignature]}, () => {
        checkIfNodeIsReady()
        return container.statisticsManager.getStatistics()
    })
    registerRoute(app, 'get', '/config', {middleware: [validateSignature]}, () => {
        checkIfNodeIsReady()
        return container.settingsManager.getConfigForClient()
    })
    registerRoute(app, 'get', '/update', {middleware: [validateSignature]}, () => {
        checkIfNodeIsReady()
        return container.settingsManager.pendingUpdate?.toPlainObject()
    })
    registerRoute(app, 'post', '/update', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsReady()
        container.settingsManager.setUpdate(req.body)
    })
    registerRoute(app, 'post', '/config', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsInInit()
        container.settingsManager.updateConfig(req.body)
    })
    registerRoute(app, 'post', '/trace', {middleware: [validateSignature]}, (req) => {
        logger.setTrace(req.body.isTraceEnabled)
    })
}