import { mock } from 'bun:test';

// Safety net: no test may ever hit the real network (a leaked fetch would
// e.g. POST telemetry to the production endpoint). Tests that assert on
// fetch behavior overwrite this per-case.
(globalThis as any).fetch = mock(async () => {
  throw new Error('fetch is not mocked in this test');
});

// Test helpers for the react-native mock below. Render tests import these to
// observe alerts and to simulate AppState transitions.
export const mockAlert = mock(() => {});
const appStateListeners = new Set<(state: string) => void>();
export const emitAppStateChange = (state: string) => {
  appStateListeners.forEach((handler) => {
    handler(state);
  });
};

// Exposed as a callable so files that run mock.restore() can re-arm it: bun
// drops these preload module mocks on restore, which would otherwise leave
// later test files linking against the real react-native (which has no static
// NativeModules export) — a failure that only shows up under the file order
// bun happens to discover tests in.
export const installBaseMocks = () => {
  mock.module('react-native', () => {
    return {
      Platform: {
        OS: 'ios',
        Version: 13,
      },
      Alert: {
        alert: mockAlert,
      },
      AppState: {
        currentState: 'active',
        addEventListener: (_type: string, handler: (state: string) => void) => {
          appStateListeners.add(handler);
          return {
            remove: () => {
              appStateListeners.delete(handler);
            },
          };
        },
      },
      Linking: {
        openURL: mock(() => Promise.resolve()),
        getInitialURL: () => Promise.resolve(null),
        addEventListener: () => ({ remove: () => {} }),
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
        t: (key: string, params?: any) =>
          `${key}${params ? JSON.stringify(params) : ''}`,
      },
    };
  });

  mock.module('react-native/Libraries/Core/ReactNativeVersion', () => ({
    version: { major: 0, minor: 73, patch: 0 },
  }));
};

installBaseMocks();
