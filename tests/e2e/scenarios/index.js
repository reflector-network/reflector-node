//the catalogue, in the order the spec lists it
module.exports = [
    ...require('./nodes'),
    ...require('./updates'),
    ...require('./upgrade'),
    ...require('./subscriptions'),
    ...require('./local'),
    ...require('./governance'),
    ...require('./resilience'),
    ...require('./providers')
]
