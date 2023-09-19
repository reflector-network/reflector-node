const container = require('../../domain/container')
const UpdateType = require('../../models/contract/updates/update-type')
const {badRequest, forbidden} = require('../errors')
const ValidationError = require('../../models/validation-error')
const {registerRoute} = require('../router')
const {validateSignature} = require('../signature-validator')
const NodeStatus = require('../../domain/node-status')

/**
 * @typedef {import('express').Express} Express
 */

function setUpdate(data, type) {
    data.type = type
    try {
        container.settingsManager.setUpdate(data)
    } catch (e) {
        if (e instanceof ValidationError)
            throw badRequest(e.message)
        throw e
    }
}

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
    registerRoute(app, 'post', '/assets', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsReady()
        setUpdate(req.body, UpdateType.ASSETS)
    })
    registerRoute(app, 'post', '/nodes', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsReady()
        setUpdate(req.body, UpdateType.NODES)
    })
    registerRoute(app, 'post', '/period', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsReady()
        setUpdate(req.body, UpdateType.PERIOD)
    })
    registerRoute(app, 'post', '/config', {middleware: [validateSignature]}, (req) => {
        checkIfNodeIsInInit()
        container.settingsManager.updateConfig(req.body)
    })
}