/** @type {import('@jest/types').Config.InitialOptions} */
module.exports = {
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/**/*.test.js'],
  testTimeout: 300000,
  maxWorkers: 1,
  globalSetup: '<rootDir>/e2e/globalSetup.js',
  globalTeardown: '<rootDir>/e2e/globalTeardown.js',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};
