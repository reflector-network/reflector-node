const http = require('http')
const express = require('express')
const bodyParser = require('body-parser')
const logger = require('../logger')
const {normalizePort} = require('../utils/port-helper')
const ValidationError = require('../models/validation-error')
const reflectorHandlers = require('./api/reflector-handlers')
const {badRequest} = require('./errors')

class HttpServer {
    /**
     * @type {Set<Duplex>}
     * @private
     */
    sockets = new Set()

    start() {
        if (this.server) return
        this.app = express()
        this.app.disable('x-powered-by')

        this.app.use(bodyParser.json())
        this.app.use(bodyParser.urlencoded({extended: false}))

        this.registerRoutes()

        //error handler
        this.app.use((err, req, res, next) => {
            if (err.internalError)
                logger.error(err)
            if (res.headersSent) return next(err)
            if (err instanceof ValidationError)
                err = badRequest(err.message, err.details)
            if (err.code && err.code < 500) {
                res.status(err.code).send({code: err.code, error: err.message, details: err.details})
            } else
                res.status(500).send({code: 500, error: 'Internal server error'})
        })

        const port = normalizePort(process.env.API_PORT || 30347)

        //set API port
        this.app.set('port', port)

        //instantiate server
        this.server = this.httpServer = http.createServer(this.app)
        this.server.listen(port)

        this.server.on('listening', () => {
            const addr = this.server.address()
            const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port
            logger.info('Http server listening on ' + bind)
        })

        this.server.on('connection', socket => { //for HTTPS servers use 'secureConnection' even instead
            try {
                if (this.terminating) { //kill all new connections if we are in termination mode
                    socket.destroy()
                    return
                }

                this.sockets.add(socket)
                socket.once('close', () => {
                    this.sockets.delete(socket)
                })
            } catch (err) {
                logger.error('Http server error')
                logger.error(err)
            }
        })

        this.server.on('error', (error) => {
            logger.error('Http server error')
            logger.error(error)
        })
    }

    async close() {
        if (this.terminating || !this.server) return
        this.terminating = true

        function setClosedConnectionHeader(response) {
            if (!response.headersSent) {
                response.setHeader('connection', 'close')
            }
        }

        this.httpServer.on('request', (incomingMessage, outgoingMessage) => setClosedConnectionHeader(outgoingMessage))

        for (const socket of this.sockets) {
            if (!(socket.server instanceof http.Server)) continue

            const serverResponse = socket._httpMessage
            if (serverResponse) {
                setClosedConnectionHeader(serverResponse)
                continue //do not close this connection for now -- it still can return the response to the client
            }
            socket.destroy()
            this.sockets.delete(socket)
        }

        //wait for all in-flight connections to drain, forcefully terminating any open connections after the given timeout
        try {
            const interval = 100 //check every 100 milliseconds
            for (let i = 0; i < this.gracefulTerminationTimeout; i += interval) {
                if (this.sockets.size === 0) break
                await new Promise(r => setTimeout(r, interval))
            }
        } catch {
            //ignore timeout errors
        } finally {
            for (const socket of this.sockets) {
                socket.destroy()
                this.sockets.delete(socket)
            }
        }

        return await new Promise(resolve => {
            this.httpServer.close((error) => {
                if (error) {
                    logger.error('Failed to terminate HTTP server connections')
                    logger.error(error)
                }
                resolve()
            })
        })
    }

    registerRoutes() {
        reflectorHandlers(this.app)
    }
}

module.exports = HttpServer