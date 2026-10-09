const fs = require('fs')
const path = require('path')

//errors of a directory fsync the platform does not offer: Windows opens a directory but refuses to flush it (EPERM),
//or refuses to open one (EISDIR), and some file systems do not implement it (EINVAL, ENOTSUP)
const unsupportedDirectorySync = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'])

/**
 * @param {string} filePath - target file
 * @param {number|string} id - writer id
 * @returns {string} the temporary file a writer uses for the target
 */
function getTemporaryPath(filePath, id) {
    return `${filePath}.${id}.tmp`
}

/**
 * Removes temporary files an earlier process left for the target when it stopped between opening and renaming one. They
 * are owner-only, but a leftover .config.json one holds the cluster secret, and nothing else would ever remove it
 * @param {string} filePath - target file
 */
function removeStaleTemporaryFiles(filePath) {
    const dir = path.dirname(filePath)
    const prefix = `${path.basename(filePath)}.`
    let names = []
    try {
        names = fs.readdirSync(dir)
    } catch (err) {
        return //the write below reports a directory it cannot use
    }
    for (const name of names) {
        if (!name.startsWith(prefix) || !/^\d+\.tmp$/.test(name.slice(prefix.length)))
            continue
        try {
            fs.rmSync(path.join(dir, name), {force: true})
        } catch (err) {
            //left for the next write to try again; it never stands in the way of this one
        }
    }
}

/**
 * Flushes a directory, so that a rename in it survives a power loss
 * @param {string} dir - directory
 */
function syncDirectory(dir) {
    let fd = null
    try {
        fd = fs.openSync(dir, 'r')
        fs.fsyncSync(fd)
    } catch (err) {
        if (!unsupportedDirectorySync.has(err.code))
            throw err
    } finally {
        if (fd !== null)
            fs.closeSync(fd)
    }
}

/**
 * Writes a file so that a crash leaves the old content or the new one, never a torn file: the data goes to a temporary
 * file beside the target, is flushed to disk and renamed over the target, which replaces it in one step on the same file
 * system, and the directory is flushed so that the rename itself survives a power loss where the platform allows it.
 * The file is created readable by its owner only, because the files written this way hold the node seed, the cluster
 * RSA key and the replay-protection nonces
 * @param {string} filePath - target file
 * @param {string} data - content
 * @param {number} [mode] - permission bits of the file
 */
function writeFileAtomic(filePath, data, mode = 0o600) {
    removeStaleTemporaryFiles(filePath)
    const tmpPath = getTemporaryPath(filePath, process.pid)
    try {
        const fd = fs.openSync(tmpPath, 'w', mode)
        try {
            fs.writeFileSync(fd, data)
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        //a temporary file left by an earlier crash keeps its own bits, so they are set explicitly
        fs.chmodSync(tmpPath, mode)
        fs.renameSync(tmpPath, filePath)
        syncDirectory(path.dirname(filePath))
    } catch (err) {
        try {
            fs.rmSync(tmpPath, {force: true})
        } catch (cleanupErr) {
            //the error that stopped the write is the one the caller must see
        }
        throw err
    }
}

module.exports = {writeFileAtomic}
