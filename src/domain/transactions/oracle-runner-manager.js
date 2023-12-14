const ClusteUpdatesRunner = require('./cluster-updates-runner')
const OracleRunner = require('./oracle-price-runner')

class OracleRunnerManager {
    /**
     * @type {Map<string, OracleRunner>}
     */
    oracleRunners = new Map()

    /**
     * @type {OracleRunner}
     */
    updatesRunner = new ClusteUpdatesRunner()

    setOracleIds(oracleIds) {
        const allRunnerIds = [...this.oracleRunners.keys()]
        const allKeys = new Set([...allRunnerIds, ...oracleIds])
        for (const oracleId of allKeys) {
            const presentedInOracleIds = oracleIds.indexOf(oracleId) >= 0
            if (presentedInOracleIds)
                this.add(oracleId)
            else
                this.remove(oracleId)
        }
    }

    /**
     * @param {string} oracleId - oracle id
     * @returns {OracleRunner}
     */
    get(oracleId) {
        if (!this.oracleRunners.has(oracleId))
            throw new Error(`Oracle runner not found for oracle id: ${oracleId}`)
        return this.oracleRunners.get(oracleId)
    }

    /**
     * @param {string} oracleId - oracle id
     * @returns {boolean}
     */
    has(oracleId) {
        return this.oracleRunners.has(oracleId)
    }

    /**
     * @param {string} oracleId - oracle id
     * @returns {OracleRunner}
     */
    add(oracleId) {
        if (this.oracleRunners.has(oracleId))
            return
        const oracleRunner = new OracleRunner(oracleId)
        this.oracleRunners.set(oracleId, oracleRunner)
        return oracleRunner
    }

    /**
     * @param {string} oracleId - oracle id
     */
    remove(oracleId) {
        if (!this.oracleRunners.has(oracleId))
            return
        const oracleRunner = this.oracleRunners.get(oracleId)
        oracleRunner.stop()
        this.oracleRunners.delete(oracleId)
    }
}

module.exports = OracleRunnerManager