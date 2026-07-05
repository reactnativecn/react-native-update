const path = require('node:path');

module.exports = {
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/harmony/**/*.test.ts'],
  testTimeout: 300000,
  maxWorkers: 1,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: path.resolve(__dirname, '../babel.config.js') },
    ],
  },
  globalSetup: '<rootDir>/e2e/harmony/globalSetup.js',
  globalTeardown: '<rootDir>/e2e/harmony/globalTeardown.js',
  testEnvironment: 'node',
  verbose: true,
};
