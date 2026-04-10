import { describe, expect, test, mock } from 'bun:test';

// In Bun, top-level imports are cached.
// We can use mock.module to change the implementation of a module,
// but if a module has already been executed (like core.ts),
// re-importing it might not re-run the top-level code unless we use some tricks
// or run tests in isolation.
// Actually, bun test runs each file in its own environment usually,
// BUT if we run multiple test files in one process, they might share the cache.
const importFreshCore = (cacheKey: string) => import(`../core?${cacheKey}`);

describe('core info parsing', () => {
  test('should call error when currentVersionInfo is invalid JSON', async () => {
    const mockError = mock(() => {});

    mock.module('react-native', () => ({
      Platform: {
        OS: 'ios',
        Version: 13,
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
          bundleHash: 'bundle-hash',
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

    mock.module('../utils', () => ({
      error: mockError,
      log: mock(() => {}),
      emptyModule: {},
    }));

    // Use a unique query parameter to bypass cache if supported, or just rely on fresh environment per file.
    // In Bun, you can sometimes use a cache buster if it's dynamic import.
    await importFreshCore('error');

    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('error_parse_version_info')
    );
  });

  test('should not call error when currentVersionInfo is valid JSON', async () => {
    const mockError = mock(() => {});
    const mockSetLocalHashInfo = mock(() => {});

    mock.module('react-native', () => ({
      Platform: {
        OS: 'ios',
        Version: 13,
      },
      NativeModules: {
        Pushy: {
          currentVersionInfo: JSON.stringify({ name: 'v1', debugChannel: true }),
          downloadRootDir: '/tmp',
          packageVersion: '1.0.0',
          currentVersion: 'hash1',
          isFirstTime: false,
          rolledBackVersion: '',
          buildTime: '2023-01-01',
          bundleHash: 'bundle-hash',
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

    mock.module('../utils', () => ({
      error: mockError,
      log: mock(() => {}),
      emptyModule: {},
    }));

    await importFreshCore('success');

    expect(mockError).not.toHaveBeenCalled();
  });
});
