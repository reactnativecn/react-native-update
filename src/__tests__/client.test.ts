import { describe, expect, mock, test } from 'bun:test';

const importFreshClient = (cacheKey: string) => import(`../client?${cacheKey}`);

const createJsonResponse = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }) as Response;

const setupClientMocks = ({
  isFirstTime = false,
  markSuccess = mock(() => {}),
}: {
  isFirstTime?: boolean;
  markSuccess?: ReturnType<typeof mock>;
} = {}) => {
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
      markSuccess,
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
    isFirstTime,
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

  test('calls afterCheckUpdate with skipped when beforeCheckUpdate returns false', async () => {
    setupClientMocks();
    const beforeCheckUpdate = mock(() => false);
    const afterCheckUpdate = mock(() => {});

    const { Pushy } = await importFreshClient('after-check-update-skipped');
    const client = new Pushy({
      appKey: 'demo-app',
      beforeCheckUpdate,
      afterCheckUpdate,
    });

    expect(await client.checkUpdate()).toBeUndefined();
    expect(afterCheckUpdate).toHaveBeenCalledWith({
      status: 'skipped',
    });
  });

  test('calls afterCheckUpdate with completed and result when check succeeds', async () => {
    setupClientMocks();
    const afterCheckUpdate = mock(() => {});
    const checkResult = {
      update: true as const,
      name: '1.0.1',
      hash: 'next-hash',
      description: 'bugfix',
    };
    (globalThis as any).fetch = mock(async () => createJsonResponse(checkResult));

    const { Pushy } = await importFreshClient('after-check-update-completed');
    const client = new Pushy({
      appKey: 'demo-app',
      afterCheckUpdate,
    });

    expect(await client.checkUpdate()).toEqual(checkResult);
    expect(afterCheckUpdate).toHaveBeenCalledWith({
      status: 'completed',
      result: checkResult,
    });
  });

  test('calls afterCheckUpdate with error before rethrowing when throwError is enabled', async () => {
    setupClientMocks();
    const afterCheckUpdate = mock(() => {});
    const fetchError = new Error('boom');
    (globalThis as any).fetch = mock(async () => {
      throw fetchError;
    });

    const { Pushy } = await importFreshClient('after-check-update-error');
    const client = new Pushy({
      appKey: 'demo-app',
      throwError: true,
      afterCheckUpdate,
    });

    await expect(client.checkUpdate()).rejects.toThrow('boom');
    expect(afterCheckUpdate).toHaveBeenCalledWith({
      status: 'error',
      error: fetchError,
    });
  });

  test('waits for native markSuccess before logging success', async () => {
    let resolveNativeMarkSuccess = () => {};
    const nativeMarkSuccess = mock(
      () =>
        new Promise<void>(resolve => {
          resolveNativeMarkSuccess = resolve;
        }),
    );
    const logger = mock(() => {});
    setupClientMocks({
      isFirstTime: true,
      markSuccess: nativeMarkSuccess,
    });

    const { Pushy, sharedState } = await importFreshClient('mark-success-awaits-native');
    const client = new Pushy({
      appKey: 'demo-app',
      logger,
    });

    const markPromise = client.markSuccess();
    expect(nativeMarkSuccess).toHaveBeenCalledTimes(1);
    expect(sharedState.marked).toBe(false);
    expect(logger).not.toHaveBeenCalled();

    resolveNativeMarkSuccess();
    await markPromise;

    expect(sharedState.marked).toBe(true);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'markSuccess',
      }),
    );
  });
});
