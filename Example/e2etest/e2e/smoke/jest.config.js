const path = require('node:path');

const moduleDir = __dirname;

// Debug 构建启动冒烟专用 runner 配置:不需要本地更新 server 和 ppk 产物,
// 直接用 Detox 原生的 global hooks,跳过 ../globalSetup 的整套准备流程。
/** @type {import('jest').Config} */
const config = {
  rootDir: '../..',
  testMatch: ['<rootDir>/e2e/smoke/**/*.test.ts'],
  testTimeout: 420000,
  maxWorkers: 1,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: path.resolve(moduleDir, '../../babel.config.js') },
    ],
  },
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};

module.exports = config;
