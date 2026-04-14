/*eslint-disable no-undef */
jest.mock('../src/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
    init: jest.fn(),
    setTrace: jest.fn(),
    addMetrics: jest.fn(),
    level: 'info'
}))
