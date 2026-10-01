/*eslint-disable no-undef */
const mockRequest = jest.fn(() => Promise.resolve({status: 200, data: 'ok'}))

jest.mock('axios', () => ({default: {request: (...args) => mockRequest(...args), defaults: {}}}))
jest.mock('dns', () => {
    const actual = jest.requireActual('dns')
    return {...actual, promises: {...actual.promises, lookup: () => new Promise(() => {})}}
})

const {makeRequest} = require('../../src/utils/requests-helper')

describe('outbound request deadline', () => {
    test('a name that never resolves does not outlive the request budget', async () => {
        const start = Date.now()
        //axios `timeout` is socket inactivity and does not cover dns at all; the orchestrator measured the same
        //defect as a request held open for 96 271 ms against a 5 000 ms setting
        await expect(makeRequest('http://slow.example.com/hook', {validateSsrf: true, timeout: 400}))
            .rejects.toMatchObject({safeMessage: 'Request timed out'})
        expect(Date.now() - start).toBeLessThan(2500)
        expect(mockRequest).not.toHaveBeenCalled()
    })
})
