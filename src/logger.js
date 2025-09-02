const fs = require('fs')
const path = require('path')
const pino = require('pino')
const rfs = require('rotating-file-stream')
const container = require('./domain/container')
const {isDebugging} = require('./utils/utils')
const {storage} = require('./async-storage')

const traceLevel = 'trace'
const infoLevel = 'info'
const logsDir = `${container.homeDir}/logs/`
const metricsDir = `${logsDir}/metrics/`
const MAX_LOG_FILE_SIZE = '2M'
const LOG_RETENTION_DAYS = '7d'
const MAX_FILES = 20

const basePath = path.resolve(path.resolve(process.cwd()), '..') + path.sep

const circularRefTag = 'circular-ref-tag'

const originalConsoleError = console.error
const originalConsoleWarn = console.warn
const originalConsoleInfo = console.info
const originalConsoleLog = console.log
const originalConsoleDebug = console.debug

//Override console.error
console.error = (...args) => {
    //Log the error using Pino
    logger.error(...args)

    //Call the original console.error
    originalConsoleError(...args)
}

//Override console.warn
console.warn = (...args) => {
    //Log the warn using Pino
    logger.warn(...args)

    //Call the original console.warn
    if (originalConsoleWarn)
        originalConsoleWarn(...args)
}

//Override console.info
console.info = (...args) => {
    //Log the info using Pino
    logger.info(...args)

    //Call the original console.info
    if (originalConsoleInfo)
        originalConsoleInfo(...args)
}

//Override console.log
console.log = (...args) => {
    //Log the log using Pino
    logger.info(...args)

    //Call the original console.log
    if (originalConsoleLog)
        originalConsoleLog(...args)
}

//Override console.debug
console.debug = (...args) => {
    //Log the debug using Pino
    logger.debug(...args)

    //Call the original console.debug
    if (originalConsoleDebug)
        originalConsoleDebug(...args)
}

//replace absolute paths in stack trace with relative paths
const cleanup = data => {
    if (data && typeof data === 'object') {
        data[circularRefTag] = true
        const keys = Object.getOwnPropertyNames(data)
        for (const key of keys) {
            const value = data[key]
            if (key === circularRefTag || (value && typeof value === 'object' && value[circularRefTag]))
                continue
            data[key] = cleanup(data[key])
        }
        delete data[circularRefTag]
        return data
    } else if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
            data[i] = cleanup(data[i])
        }
        return data
    } else if (typeof data !== 'string') {
        return data
    }
    return data
        .replaceAll(basePath, './')
        .replaceAll(/(\d+)\.(\d+)\.(\d+)\.(\d+)/g, '$1.***.***.$4')
        .replaceAll('\\', '/')
}

const errorSerializer = err => {
    if (err) {
        err = cleanup(err)
    }
    return pino.stdSerializers.err(err)
}

const msgSerializer = msg => {
    if (msg) {
        msg = cleanup(msg)
    }
    return typeof msg === 'string' ? msg : {msg}
}

const baseLogOptions = {
    level: traceLevel,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    serializers: {err: errorSerializer, msg: msgSerializer},
    formatters: {
        level(label) {
            return {level: label}
        },
        bindings() {
            return {}
        }
    },
    mixin() {
        return {ctxId: storage.getStore()?.id}
    }
}

if (!fs.existsSync(metricsDir)) {
    fs.mkdirSync(metricsDir, {recursive: true})
}

//configure rotating-file-stream
const rfsOptions = {
    size: MAX_LOG_FILE_SIZE,
    interval: LOG_RETENTION_DAYS,
    path: logsDir,
    maxFiles: MAX_FILES
}

function createGenerator(filename) {
    const pad = (num) => (num > 9 ? '' : '0') + num

    return (time, index) => {
        if (!time)
            time = new Date()

        const month = time.getFullYear() + '' + pad(time.getMonth() + 1)
        const day = pad(time.getDate())
        const hour = pad(time.getHours())
        const minute = pad(time.getMinutes())

        return month + day + '-' + hour + minute + '-' + pad(index || 0) + '-' + filename
    }
}

const errorLogStream = rfs.createStream('error.log', rfsOptions)
const combinedLogStream = rfs.createStream(createGenerator('combined.log'), rfsOptions)


const streams = [
    {stream: errorLogStream, level: 'error'},
    {stream: combinedLogStream, level: traceLevel, combined: true}
]

if (isDebugging()) {
    streams.push({
        stream: process.stdout,
        level: traceLevel,
        combined: true
    })
}

const logger = pino(baseLogOptions, pino.multistream(streams))
logger.level = infoLevel

logger.init = (trace) => {
    logger.setTrace(trace)
}

logger.setTrace = (trace) => {
    logger.level = trace ? traceLevel : infoLevel
    streams.filter(s => s.combined)
        .forEach(s => {
            s.level = logger.level
        })
    if (trace)
        logger.trace(`Logger level set to ${logger.level}`)
    else
        logger.info(`Logger level set to ${logger.level}`)
}

const metricsLogStream = rfs.createStream(createGenerator('metrics.log'), {...rfsOptions, path: metricsDir})
const metricsLogger = pino(baseLogOptions, metricsLogStream)
metricsLogger.level = 'info'

logger.addMetrics = (data) => {
    if (data) {
        metricsLogger.info(data)
        logger.debug('Metrics data logged')
    }
}

module.exports = logger