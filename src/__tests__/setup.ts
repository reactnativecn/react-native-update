import { afterEach, mock } from 'bun:test';

// Safety net: no test may ever hit the real network (a leaked fetch would
// e.g. POST telemetry to the production endpoint). Tests that assert on
// fetch behavior overwrite this per-case; the global afterEach below puts it
// back so one test's stub can never answer another test's request.
const unmockedFetch = mock(async () => {
  throw new Error('fetch is not mocked in this test');
});
(globalThis as any).fetch = unmockedFetch;

// Test helpers for the react-native mock below. Render tests import these to
// observe alerts and to simulate AppState transitions.
export const mockAlert = mock(() => {});
const appStateListeners = new Set<(state: string) => void>();
export const emitAppStateChange = (state: string) => {
  appStateListeners.forEach((handler) => {
    handler(state);
  });
};

const installBaseMocks = () => {
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
          rolledBackVersion: 'rolled-back-hash',
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

// Real implementations of the shared modules a test may stub, captured here —
// before any test has run — so they can be handed back. Covers every leaf
// module rather than just today's stub targets, so the next test to mock one
// doesn't have to know to add it. (The modules under test — client, provider,
// context — are absent on purpose: tests import those through cache-busting
// specifiers, which mock.module() does not touch.)
const realProjectModules: Record<string, Record<string, unknown>> = {
  '../core': { ...(await import('../core')) },
  '../endpoint': { ...(await import('../endpoint')) },
  '../error': { ...(await import('../error')) },
  '../permissions': { ...(await import('../permissions')) },
  '../telemetry': { ...(await import('../telemetry')) },
  '../updateFlowCore': { ...(await import('../updateFlowCore')) },
  '../utils': { ...(await import('../utils')) },
};

// bun's mock.module() registry is process-global: it rewrites the live module
// record, so a stub keeps answering for every test bun runs afterwards, in this
// file and in every file after it — and the damage is quiet, either a stub
// standing in for the real function or a module that no longer links, which
// skips its whole file without failing the run. mock.restore() is no cure; it
// drops this preload's mocks too, which is how the real react-native (no static
// NativeModules export) leaks back in. Resetting centrally after every test
// makes the rule uniform: a module mock lives for exactly one test, so install
// mocks per test (in the test body or a beforeEach), never at file scope.
afterEach(() => {
  mock.restore();
  installBaseMocks();
  for (const [specifier, exports] of Object.entries(realProjectModules)) {
    mock.module(specifier, () => exports);
  }
  // Likewise, one test's fetch stub must never answer another test's request.
  (globalThis as any).fetch = unmockedFetch;
});
