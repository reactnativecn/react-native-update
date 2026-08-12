const path = require('node:path');

const moduleDir = __dirname;

// 原生冷启动检测专用 runner 配置。与 ../jest.config.js 的唯一区别是 testMatch:
// 该 suite 每条断言都要真实重启 app,单独成 CI job 后与其它 suite 并行,不再
// 挤占 iOS 那个已经贴着 40 分钟上限的预算。本地更新 server 与 ppk 产物仍然
// 需要,所以沿用同一套 globalSetup。
/** @type {import('jest').Config} */
const config = {
  rootDir: '../..',
  testMatch: ['<rootDir>/e2e/native/**/*.test.ts'],
  testTimeout: 300000,
  maxWorkers: 1,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: path.resolve(moduleDir, '../../babel.config.js') },
    ],
  },
  globalSetup: '<rootDir>/e2e/globalSetup.js',
  globalTeardown: '<rootDir>/e2e/globalTeardown.js',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};

module.exports = config;
