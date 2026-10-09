const constants = {
    payloadPrefix: 'reflector-node',
    handshakeTimeout: 10000, //deadline for the challenge-response handshake, ms
    maxPayload: 1024 * 1024, //largest accepted ws frame, bytes
    //unanswered handshakes held per cluster key; a newer one closes the oldest, so the real peer always gets a slot
    maxPendingPerKey: 2,
    refusedSocketGrace: 1000 //a refused socket that has not closed by then is destroyed, ms
}

module.exports = constants
