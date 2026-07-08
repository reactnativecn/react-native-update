const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const {FileStore} = require('metro-cache');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  // transform cache 是内容寻址的,落到项目内固定目录让 CI 用 actions/cache
  // 跨 run 持久化(prep 的 4 次 ppk 打包 + xcodebuild 里的基座打包共享)。
  cacheStores: [new FileStore({root: path.join(__dirname, '.metro-cache')})],
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
