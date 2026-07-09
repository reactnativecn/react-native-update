const path = require('node:path');

const moduleDir = __dirname;

/** @type {import('jest').Config} */
const config = {
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/**/*.test.ts'],
  // Harmony tests use their own runner (harmony.jest.config.js), not Detox.
  // The debug boot smoke has its own runner config too (smoke/jest.config.js).
  testPathIgnorePatterns: ['/e2e/harmony/', '/e2e/smoke/'],
  testTimeout: 300000,
  maxWorkers: 1,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: path.resolve(moduleDir, '../babel.config.js') },
    ],
  },
  globalSetup: '<rootDir>/e2e/globalSetup.js',
  globalTeardown: '<rootDir>/e2e/globalTeardown.js',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};

module.exports = config;
