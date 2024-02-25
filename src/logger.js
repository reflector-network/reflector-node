const fs = require('fs')
const path = require('path')
const pino = require('pino')
const rfs = require('rotating-file-stream')
const container = require('./domain/container')

const isDev = process.env.NODE_ENV === 'development'
const traceLevel = 'trace'
const infoLevel = 'info'
const defaultLevel = isDev ? traceLevel : infoLevel
const folder = `${container.homeDir}/logs/`

const MAX_LOG_FILE_SIZE = '2M'
const LOG_RETENTION_DAYS = '7d'

const basePath = path.resolve(path.resolve(process.cwd()), '..') + path.sep

const circularRefTag = 'circular-ref-tag'

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
    level: defaultLevel,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    serializers: {err: errorSerializer, msg: msgSerializer},
    formatters: {
        level(label) {
            return {level: label}
        },
        bindings() {
            return {}
        }
    }
}

if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, {recursive: true})
}

//configure rotating-file-stream
const rfsOptions = {
    size: MAX_LOG_FILE_SIZE,
    interval: LOG_RETENTION_DAYS,
    path: folder,
    maxFiles: 100
}

const errorLogStream = rfs.createStream('error.log', rfsOptions)
const combinedLogStream = rfs.createStream('combined.log', rfsOptions)


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

logger.setTrace = (isTraceEnabled) => {
    if (isTraceEnabled) {
        logger.level = traceLevel
    } else {
        logger.level = infoLevel
    }
}

logger.isTraceEnabled = () => logger.level === traceLevel

module.exports = logger