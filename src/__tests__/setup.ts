import { mock } from 'bun:test';

mock.module('react-native', () => {
  return {
    Platform: {
      OS: 'ios',
      Version: 13,
    },
    DeviceEventEmitter: {
      addListener: () => ({ remove: () => {} }),
    },
    NativeModules: {
      Pushy: {
        currentVersionInfo: '{}',
        downloadRootDir: '/tmp',
        packageVersion: '1.0.0',
        currentVersion: 'hash',
        isFirstTime: false,
        rolledBackVersion: '',
        buildTime: '2023-01-01',
        bundleHash: 'bundle-hash',
        uuid: 'uuid',
        setLocalHashInfo: () => {},
        getLocalHashInfo: () => Promise.resolve('{}'),
        setUuid: () => {},
      },
    },
    NativeEventEmitter: class {
      addListener = () => ({ remove: () => {} });
      removeAllListeners = () => {};
    },
  };
});

mock.module('../i18n', () => {
  return {
    default: {
      t: (key: string, params?: any) => `${key}${params ? JSON.stringify(params) : ''}`,
    },
  };
});
