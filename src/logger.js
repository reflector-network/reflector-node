const fs = require('fs')
const pino = require('pino')
const rfs = require('rotating-file-stream')
const container = require('./domain/container')
const {isDebugging} = require('./utils/utils')
const {storage} = require('./async-storage')
const {redactString, safeUrl} = require('./utils/log-redaction')

const traceLevel = 'trace'
const infoLevel = 'info'
const logsDir = `${container.homeDir}/logs/`
const metricsDir = `${logsDir}/metrics/`
const MAX_LOG_FILE_SIZE = '2M'
const LOG_RETENTION_DAYS = '7d'
const MAX_FILES = 20

const circularRefTag = 'circular-ref-tag'

//keys whose value is a secret wherever it appears in a logged object, down to the depth a config item is logged at
const secretKeys = ['secret', 'clusterSecret', 'apiKey', 'gatewayValidationKey']
const secretPaths = secretKeys.flatMap(key => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`])

/**
 * Replaces an axios-shaped error with a small one: pino's error serializer copies every enumerable property, and an
 * axios error carries the request headers (a gateway's x-gateway-validation token among them), the body and the full url
 * @param {any} err - error to filter
 * @returns {any} the same value when it is not axios-shaped
 */
function filterError(err) {
    if (!err || typeof err !== 'object')
        return err
    if (!err.isAxiosError && !err.config && !err.request && !err.response)
        return err
    const filtered = new Error(err.message)
    filtered.name = err.name
    filtered.stack = err.stack
    if (err.code !== undefined)
        filtered.code = err.code
    const status = err.response && err.response.status !== undefined ? err.response.status : err.status
    if (status !== undefined)
        filtered.status = status
    const url = safeUrl(err.config && err.config.url)
    if (url !== undefined)
        filtered.url = url
    return filtered
}

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
const cleanup = (data, seen) => {
    if (Array.isArray(data)) {
        return data.map(item => cleanup(item, seen))
    }
    if (data && typeof data === 'object') {
        if (!seen)
            seen = new Set()
        if (seen.has(data))
            return '[Circular]'
        seen.add(data)
        const result = {}
        for (const key of Object.getOwnPropertyNames(data)) {
            result[key] = cleanup(data[key], seen)
        }
        return result
    }
    if (typeof data !== 'string') {
        return data
    }
    return redactString(data)
}

const errorSerializer = err => {
    if (err) {
        err = cleanup(filterError(err))
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
    redact: {paths: secretPaths, censor: '[redacted]'},
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

const errorLogStream = rfs.createStream('error.log', rfsOptions)
const combinedLogStream = rfs.createStream('combined.log', rfsOptions)


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

const metricsLogStream = rfs.createStream('metrics.log', {...rfsOptions, path: metricsDir})
const metricsLogger = pino(baseLogOptions, metricsLogStream)
metricsLogger.level = 'info'

logger.addMetrics = (data) => {
    if (data) {
        metricsLogger.info(data)
        logger.debug('Metrics data logged')
    }
}

logger.__cleanup = cleanup

module.exports = logger