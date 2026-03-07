import { mock } from 'bun:test';

mock.module('react-native', () => {
  return {
    Platform: {
      OS: 'ios',
      Version: 13,
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

mock.module('react-native/Libraries/Core/ReactNativeVersion', () => {
  return {
    version: {
      major: 0,
      minor: 70,
      patch: 0,
    },
  };
});
