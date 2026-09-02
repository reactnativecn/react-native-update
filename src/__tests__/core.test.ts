import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

// In Bun, top-level imports are cached.
// We can use mock.module to change the implementation of a module,
// but if a module has already been executed (like core.ts),
// re-importing it might not re-run the top-level code unless we use some tricks
// or run tests in isolation.
// Actually, bun test runs each file in its own environment usually,
// BUT if we run multiple test files in one process, they might share the cache.
const importFreshCore = (cacheKey: string) => import(`../core?${cacheKey}`);
const importFreshClient = (cacheKey: string) => import(`../client?${cacheKey}`);

describe('core info parsing', () => {
  test('should call error when currentVersionInfo is invalid JSON', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});

    mock.module('react-native', () => ({
      Platform: {
        OS: 'ios',
        Version: 13,
      },
      DeviceEventEmitter: {
        addListener: mock(() => ({ remove: mock(() => {}) })),
      },
      NativeModules: {
        Pushy: {
          currentVersionInfo: '{invalid}',
          downloadRootDir: '/tmp',
          packageVersion: '1.0.0',
          currentVersion: 'hash1',
          isFirstTime: false,
          rolledBackVersion: '',
          buildTime: '2023-01-01',
          uuid: 'existing-uuid',
          setLocalHashInfo: mock(() => {}),
          getLocalHashInfo: mock(() => Promise.resolve('{}')),
          setUuid: mock(() => {}),
        },
      },
      NativeEventEmitter: class {
        addListener = mock(() => ({ remove: mock(() => {}) }));
      },
    }));

    mock.module('react-native/Libraries/Core/ReactNativeVersion', () => ({
      version: { major: 0, minor: 73, patch: 0 },
    }));

    mock.module('nanoid/non-secure', () => ({
      nanoid: () => 'mock-uuid',
    }));

    // Use a unique query parameter to bypass cache if supported, or just rely on fresh environment per file.
    // In Bun, you can sometimes use a cache buster if it's dynamic import.
    await importFreshCore('error');

    expect(consoleError).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('error_parse_version_info')
    );

    consoleError.mockRestore();
  });

  test('should not call error when currentVersionInfo is valid JSON', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const mockSetLocalHashInfo = mock(() => {});

    mock.module('react-native', () => ({
      Platform: {
        OS: 'ios',
        Version: 13,
      },
      DeviceEventEmitter: {
        addListener: mock(() => ({ remove: mock(() => {}) })),
      },
      NativeModules: {
        Pushy: {
          currentVersionInfo: JSON.stringify({
            name: 'v1',
            debugChannel: true,
          }),
          downloadRootDir: '/tmp',
          packageVersion: '1.0.0',
          currentVersion: 'hash1',
          isFirstTime: false,
          rolledBackVersion: '',
          buildTime: '2023-01-01',
          uuid: 'existing-uuid',
          setLocalHashInfo: mockSetLocalHashInfo,
          getLocalHashInfo: mock(() => Promise.resolve('{}')),
          setUuid: mock(() => {}),
        },
      },
      NativeEventEmitter: class {
        addListener = mock(() => ({ remove: mock(() => {}) }));
      },
    }));

    await importFreshCore('success');

    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });
});

describe('web platform', () => {
  const origDev = (globalThis as any).__DEV__;
  afterEach(() => {
    (globalThis as any).__DEV__ = origDev;
  });

  test('constants are explicit empties, no native calls, no rollback telemetry (1.1)', async () => {
    // On web PushyModule is a Proxy of noops; reading the constants off it
    // made every one of them a function (isRolledBack === true, a "() => {}"
    // uuid, JSON.parse failing on currentVersionInfo).
    const setUuid = mock(() => {});
    const getBundleHash = mock(() => Promise.resolve('sha'));
    mock.module('react-native', () => ({
      Platform: {
        OS: 'web',
        Version: undefined,
      },
      DeviceEventEmitter: {
        addListener: mock(() => ({ remove: mock(() => {}) })),
      },
      // Must never be touched on web.
      NativeModules: {
        Pushy: { setUuid, getBundleHash },
      },
      NativeEventEmitter: class {
        addListener = mock(() => ({ remove: mock(() => {}) }));
      },
    }));
    mock.module('react-native/Libraries/Core/ReactNativeVersion', () => ({
      version: { major: 0, minor: 73, patch: 0 },
    }));
    mock.module('nanoid/non-secure', () => ({
      nanoid: () => 'web-uuid',
    }));
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const core = await importFreshCore('web-constants');

      expect(core.isRolledBack).toBe(false);
      expect(core.isFirstTime).toBe(false);
      expect(core.rolledBackVersion).toBe('');
      expect(typeof core.currentVersion).toBe('string');
      expect(typeof core.packageVersion).toBe('string');
      expect(typeof core.buildTime).toBe('string');
      expect(typeof core.cInfo.uuid).toBe('string');
      expect(core.cInfo.uuid.length).toBeGreaterThan(0);
      expect(core.currentVersionInfo).toEqual({});
      expect(core.supportedDiffVersion).toBe(0);
      expect(core.getBundleHash()).toBe('');
      expect(setUuid).not.toHaveBeenCalled();
      expect(getBundleHash).not.toHaveBeenCalled();
      // No error_parse_version_info.
      expect(consoleError).not.toHaveBeenCalled();

      // A client built on these constants has nothing to report: before the
      // fix every page load POSTed a fake rollback to /report/{appKey}.
      (globalThis as any).__DEV__ = false;
      mock.module('../core', () => ({ ...core }));
      mock.module('../i18n', () => ({
        default: { t: (key: string) => key, setLocale: () => {} },
      }));
      const fetchMock = mock(async () => {
        throw new Error('unexpected network request');
      });
      (globalThis as any).fetch = fetchMock;
      const { Pushy } = await importFreshClient('web-constants');
      const client = new Pushy({ appKey: 'web-app' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.options.appKey).toBe('web-app');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });
});
