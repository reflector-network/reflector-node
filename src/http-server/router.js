const cors = require('cors')
const ValidationError = require('../models/validation-error')
const {badRequest} = require('./errors')


function tryConvertValidationError(err) {
    if (err instanceof ValidationError)
        return badRequest(err.message, err.details)
    return err
}

function processResponse(res, resultPromise) {
    try {
        if (!(resultPromise instanceof Promise)) {
            resultPromise = Promise.resolve(resultPromise)
        }
        resultPromise
            .then(result => res.json(result || {ok: 1}))
            .catch(err => {
                throw tryConvertValidationError(err)
            })
    } catch (err) {
        throw tryConvertValidationError(err)
    }
}

const corsMiddleware = cors()

module.exports = {
    /**
     * Register API route.
     * @param {Express} app - Express app instance.
     * @param {'get'|'post'|'put'|'delete'} method - Route method.
     * @param {string} route - Relative route path.
     * @param {object} options - Additional options.
     * @param {[function]} [options.middleware] - Request middleware to use.
     * @param {RouteHandler} handler - Request handler.
     */
    registerRoute(app, method, route, options, handler) {
        const {middleware = []} = options
        middleware.unshift(corsMiddleware)
        app[method](route, middleware, function (req, res) {
            processResponse(res, handler(req))
        })
        app.options(route, middleware, function (req, res) {
            res.send(method.toUpperCase())
        })
    }
}


/**
 * Route handler callback.
 * @callback RouteHandler
 * @param {{params: object, query: object, path: string}} req - Request object.
 */