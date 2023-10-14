const fs = require('fs')
const path = require('path')
const pino = require('pino')

const isDev = process.env.NODE_ENV === 'development'
const traceLevel = 'trace'
const infoLevel = 'info'
const defaultLevel = isDev ? traceLevel : infoLevel
const folder = './home/logs/'

const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024 //10MB
const LOG_RETENTION_DAYS = 7

function stringifyWithCircularReferences(obj) {
    const cache = new Set()
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (cache.has(value)) {
                return
            }
            cache.add(value)
        }
        return value
    })
}

const baseLogOptions = {
    level: defaultLevel,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
        level(label) {
            return {level: label}
        },
        bindings() {
            return {}
        },
        log(object) {
            if (object.stack) {
                return {msg: `${object.message} ${stringifyWithCircularReferences(object)}\n${object.stack}`}
            }
            return object
        }
    }
}

if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, {recursive: true})
}

const errorFilePath = `${folder}/error.log`
const combinedFilePath = `${folder}/combined.log`

const errorLogStream = pino.destination({dest: errorFilePath, level: 'error'})
const combinedLogStream = pino.destination({dest: combinedFilePath, level: defaultLevel})

const streams = [
    {stream: errorLogStream, level: 'error'},
    {stream: combinedLogStream, level: defaultLevel}
]

if (isDev) {
    streams.push({
        stream: process.stdout,
        level: defaultLevel
    })
}

const logger = pino(baseLogOptions, pino.multistream(streams))

function rotateLogs(filePath) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_FILE_SIZE) {
        const timestamp = new Date().toISOString().replace(/[:\-T.Z]/g, "")
        fs.renameSync(filePath, `${filePath}.${timestamp}`)
    }
}

function cleanOldLogs(folderPath) {
    const files = fs.readdirSync(folderPath)
    const now = Date.now()
    const sevenDaysTime = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

    for (const file of files) {
        const filePath = path.join(folderPath, file)
        const fileStat = fs.statSync(filePath)

        if (now - fileStat.mtimeMs > sevenDaysTime) {
            fs.unlinkSync(filePath)
        }
    }
}

function manageLogs() {
    try {
        rotateLogs(errorFilePath)
        rotateLogs(combinedFilePath)
        cleanOldLogs(folder)
    } catch (e) {
        logger.error(e)
    }
    setTimeout(manageLogs, 5 * 60 * 1000)
}

manageLogs()

logger.setTrace = (isTraceEnabled) => {
    if (isTraceEnabled) {
        logger.level = traceLevel
    } else {
        logger.level = infoLevel
    }
}

logger.isTraceEnabled = () => logger.level === traceLevel

module.exports = logger