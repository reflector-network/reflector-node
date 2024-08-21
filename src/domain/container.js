/**
 * @typedef {import('./settings-manager')} SettingsManager
 * @typedef {import('../ws-server')} WsServer
 * @typedef {import('../ws-server/handlers/handlers-manager')} HandlersManager
 * @typedef {import('./contract-manager')} ContractManager
 * @typedef {import('./prices/trades-manager')} TradesManager
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
     * @type {HandlersManager}
     * */
    handlersManager

    /**
     * @type {TradesManager}
     */
    tradesManager

    /**
     * @type {{shutdown: function(): void}}
     */
    app

    /**
     * @type {string}
     */
    version = packageInfo.version

    /**
     * @type {string}
     */
    homeDir = './home'
}

module.exports = new Container()