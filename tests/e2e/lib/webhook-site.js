//A public webhook endpoint: nodes refuse webhook urls on loopback and private addresses, so a local sink never receives
//a notification
const origin = 'https://webhook.site'

async function request(pathname, options = {}) {
    const res = await fetch(origin + pathname, {...options, headers: {accept: 'application/json', ...options.headers}})
    if (!res.ok)
        throw new Error(`webhook.site ${pathname} failed with ${res.status}`)
    return res.json()
}

/**
 * @returns {Promise<{uuid: string, url: string, view: string}>} a new endpoint, its url and the page that lists what it
 * received
 */
async function create() {
    const {uuid} = await request('/token', {method: 'POST'})
    if (!uuid)
        throw new Error('webhook.site returned no token')
    return {uuid, url: `${origin}/${uuid}`, view: `${origin}/#!/view/${uuid}`}
}

/**
 * @param {string} uuid - endpoint token
 * @returns {Promise<{method: string, content: string}[]>} the requests it received, newest first
 */
async function requests(uuid) {
    const {data} = await request(`/token/${uuid}/requests?sorting=newest&per_page=100`)
    return data || []
}

module.exports = {create, requests}
