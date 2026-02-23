const fs = require('fs')
/**
 * @typedef {import('./settings-manager')} SettingsManager
 * @typedef {import('../ws-server')} WsServer
 * @typedef {import('../ws-server/handlers/handlers-manager')} HandlersManager
 * @typedef {import('./contract-manager')} ContractManager
 * @typedef {import('./prices/trades-manager')} TradesManager
 */

const packageInfo = require('../../package.json')

class Container {
    constructor() {
        this.setHomeDir(this.homeDir)
    }

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

    setHomeDir(dir) {
        this.homeDir = dir
        try {
            if (fs.existsSync(`${this.homeDir}/valid-symbols.json`)) {
                const content = fs.readFileSync(`${this.homeDir}/valid-symbols.json`, 'utf8')
                if (content) {
                    this.validSymbols = JSON.parse(content)
                    console.log(`Loaded valid symbols from ${this.homeDir}/valid-symbols.json`)
                }
            }
        } catch (e) {
            console.warn(`Unable to load valid symbols from ${this.homeDir}/valid-symbols.json`)
            this.validSymbols = undefined
        }
    }
}

module.exports = new Container()