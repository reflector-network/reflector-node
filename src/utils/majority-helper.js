function hasMajority(totalSignersCount, signaturesCount) {
    return signaturesCount >= getMajority(totalSignersCount)
}

function getMajority(totalSignersCount) {
    return Math.floor(totalSignersCount / 2) + 1
}

module.exports = {
    hasMajority,
    getMajority
}