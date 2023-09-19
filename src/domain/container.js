/**
 * @typedef {import('./settings-manager')} SettingsManager
 * @typedef {import('../ws-server')} WsServer
 * @typedef {import('./transaction-manager')} TransactionsManager
 * @typedef {import('./statistics-manager')} StatisticsManager
 * @typedef {import('../ws-server/handlers/handlers-manager')} HandlersManager
 * @typedef {import('./nodes/nodes-manager')} NodesManager
 * @typedef {import('../http-server')} HttpServer
 */

const packageInfo = require('../../package.json')

class Container {
    /**
     * @type {SettingsManager}
     */
    settingsManager

    /**
     * @type {WsServer}
     * */
    webSocketServer

    /**
     * @type {HttpServer}
     */
    httpServer

    /**
     * @type {TransactionsManager}
     * */
    transactionsManager

    /**
     * @type {HandlersManager}
     * */
    handlersManager

    /**
     * @type {NodesManager}
     * */
    nodesManager

    /**
     * @type {StatisticsManager}
     */
    statisticsManager

    /**
     * @type {{shutdown: function(): void}}
     */
    app

    /**
     * @type {string}
     */
    version = packageInfo.version
}

module.exports = new Container()