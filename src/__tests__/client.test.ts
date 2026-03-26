import { describe, expect, mock, test } from 'bun:test';

const importFreshClient = (cacheKey: string) => import(`../client?${cacheKey}`);

const createJsonResponse = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }) as Response;

const setupClientMocks = () => {
  (globalThis as any).__DEV__ = false;

  mock.module('react-native', () => ({
    Platform: {
      OS: 'ios',
      Version: 17,
    },
    DeviceEventEmitter: {
      addListener: mock(() => ({ remove: mock(() => {}) })),
    },
    NativeEventEmitter: class {
      addListener = mock(() => ({ remove: mock(() => {}) }));
      removeAllListeners = mock(() => {});
    },
  }));

  mock.module('../core', () => ({
    PushyModule: {
      markSuccess: mock(() => {}),
      reloadUpdate: mock(() => Promise.resolve()),
      setNeedUpdate: mock(() => Promise.resolve()),
      downloadPatchFromPpk: mock(() => Promise.resolve()),
      downloadPatchFromPackage: mock(() => Promise.resolve()),
      downloadFullUpdate: mock(() => Promise.resolve()),
      downloadAndInstallApk: mock(() => Promise.resolve()),
      restartApp: mock(() => Promise.resolve()),
    },
    buildTime: '2023-01-01',
    cInfo: {
      rnu: '10.0.0',
      rn: '0.73.0',
      os: 'ios',
      uuid: 'uuid',
    },
    currentVersion: 'hash',
    currentVersionInfo: {},
    isFirstTime: false,
    isRolledBack: false,
    packageVersion: '1.0.0',
    pushyNativeEventEmitter: {
      addListener: mock(() => ({ remove: mock(() => {}) })),
    },
    rolledBackVersion: '',
    setLocalHashInfo: mock(() => {}),
  }));

  mock.module('../permissions', () => ({
    PermissionsAndroid: {
      request: mock(() => Promise.resolve('granted')),
      PERMISSIONS: {
        WRITE_EXTERNAL_STORAGE: 'WRITE_EXTERNAL_STORAGE',
      },
      RESULTS: {
        GRANTED: 'granted',
      },
    },
  }));

  mock.module('../i18n', () => ({
    default: {
      t: (key: string) => key,
      setLocale: mock(() => {}),
    },
  }));
};

describe('Pushy server config', () => {
  test('uses preset main endpoints directly as configured endpoints', async () => {
    setupClientMocks();

    const { Pushy } = await importFreshClient('preset-main');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://update.react-native.cn/api',
      'https://update.reactnative.cn/api',
    ]);
  });

  test('filters remote endpoints against all configured main endpoints', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse([
        'https://update.react-native.cn/api',
        'https://edge-a.example.com',
        'https://edge-a.example.com',
        'https://update.reactnative.cn/api',
        'https://edge-b.example.com',
      ]),
    );

    const { Pushy } = await importFreshClient('remote-main-array');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.getRemoteEndpoints()).toEqual([
      'https://edge-a.example.com',
      'https://edge-b.example.com',
    ]);
    expect(await client.getBackupEndpoints()).toEqual([
      'https://edge-a.example.com',
      'https://edge-b.example.com',
    ]);
  });

  test('clones custom server config when setOptions overrides server', async () => {
    setupClientMocks();

    const { Pushy } = await importFreshClient('clone-server-config');
    const client = new Pushy({ appKey: 'demo-app' });
    const server = {
      main: ['https://a.example.com', 'https://b.example.com'],
      queryUrls: ['https://q.example.com'],
    };

    client.setOptions({ server });
    server.main.push('https://c.example.com');
    server.queryUrls.push('https://r.example.com');

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(client.options.server?.queryUrls).toEqual(['https://q.example.com']);
  });

  test('stores lastCheckError on failed check and clears it after a successful retry', async () => {
    setupClientMocks();
    let shouldFail = true;
    (globalThis as any).fetch = mock(async (url: string) => {
      if (url.includes('/checkUpdate/')) {
        if (shouldFail) {
          throw new Error('network down');
        }
        return createJsonResponse({ upToDate: true });
      }
      return createJsonResponse([]);
    });

    const { Pushy } = await importFreshClient('check-error-state');
    const client = new Pushy({
      appKey: 'demo-app',
      server: {
        main: ['https://a.example.com'],
        queryUrls: [],
      },
    });

    const failedResult = await client.checkUpdate();

    expect(failedResult).toEqual({});
    expect(client.lastCheckError).toBeInstanceOf(Error);
    expect(client.lastCheckError?.message).toContain('network down');

    shouldFail = false;

    const successResult = await client.checkUpdate();

    expect(successResult).toEqual({ upToDate: true });
    expect(client.lastCheckError).toBeUndefined();
  });

  test('clears stale lastCheckError when check is skipped by beforeCheckUpdate', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async (url: string) => {
      if (url.includes('/checkUpdate/')) {
        throw new Error('network down');
      }
      return createJsonResponse([]);
    });

    const { Pushy } = await importFreshClient('clear-error-on-skip');
    const client = new Pushy({
      appKey: 'demo-app',
      server: {
        main: ['https://a.example.com'],
        queryUrls: [],
      },
    });

    await client.checkUpdate();
    expect(client.lastCheckError).toBeInstanceOf(Error);

    client.setOptions({
      beforeCheckUpdate: () => false,
    });

    const skippedResult = await client.checkUpdate();

    expect(skippedResult).toBeUndefined();
    expect(client.lastCheckError).toBeUndefined();
  });
});
