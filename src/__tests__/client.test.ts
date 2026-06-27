import { afterEach, describe, expect, mock, test } from 'bun:test';

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
  reloadUpdate = mock(() => Promise.resolve()),
  setNeedUpdate = mock(() => Promise.resolve()),
  downloadPatchFromPpk = mock(() => Promise.resolve()),
  downloadPatchFromPackage = mock(() => Promise.resolve()),
  downloadFullUpdate = mock(() => Promise.resolve()),
  restartApp = mock(() => Promise.resolve()),
}: {
  isFirstTime?: boolean;
  markSuccess?: ReturnType<typeof mock>;
  reloadUpdate?: ReturnType<typeof mock>;
  setNeedUpdate?: ReturnType<typeof mock>;
  downloadPatchFromPpk?: ReturnType<typeof mock>;
  downloadPatchFromPackage?: ReturnType<typeof mock>;
  downloadFullUpdate?: ReturnType<typeof mock>;
  restartApp?: ReturnType<typeof mock>;
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
      reloadUpdate,
      setNeedUpdate,
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
      downloadAndInstallApk: mock(() => Promise.resolve()),
      restartApp,
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

  test('skips downloading when update hash is already current', async () => {
    const downloadPatchFromPpk = mock(() => Promise.resolve());
    const downloadPatchFromPackage = mock(() => Promise.resolve());
    const downloadFullUpdate = mock(() => Promise.resolve());
    const logger = mock(() => {});
    setupClientMocks({
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    });

    const { Pushy } = await importFreshClient('skip-current-hash-download');
    const client = new Pushy({
      appKey: 'demo-app',
      logger,
    });

    await expect(
      client.downloadUpdate({
        update: true,
        hash: 'hash',
        full: 'hash',
        paths: ['cdn.example.com'],
      }),
    ).resolves.toBeUndefined();

    expect(downloadPatchFromPpk).not.toHaveBeenCalled();
    expect(downloadPatchFromPackage).not.toHaveBeenCalled();
    expect(downloadFullUpdate).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'downloading',
      }),
    );
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

  test('waits for beforeReload before switching version', async () => {
    const calls: string[] = [];
    const reloadUpdate = mock(() => {
      calls.push('reloadUpdate');
      return Promise.resolve();
    });
    const beforeReload = mock(async (context: any) => {
      calls.push('beforeReload');
      expect(context).toEqual({
        type: 'switchVersion',
        hash: 'next-hash',
      });
    });
    setupClientMocks({ reloadUpdate });

    const { Pushy, sharedState } = await importFreshClient('before-reload-switch-version');
    sharedState.downloadedHash = 'next-hash';
    const client = new Pushy({
      appKey: 'demo-app',
      beforeReload,
    });

    await client.switchVersion('next-hash');

    expect(calls).toEqual(['beforeReload', 'reloadUpdate']);
    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(reloadUpdate).toHaveBeenCalledWith({ hash: 'next-hash' });
  });

  test('skips switching version when beforeReload returns false', async () => {
    const reloadUpdate = mock(() => Promise.resolve());
    const beforeReload = mock(() => false);
    setupClientMocks({ reloadUpdate });

    const { Pushy, sharedState } = await importFreshClient('before-reload-skip-switch');
    sharedState.downloadedHash = 'next-hash';
    const client = new Pushy({
      appKey: 'demo-app',
      beforeReload,
    });

    await client.switchVersion('next-hash');

    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(reloadUpdate).not.toHaveBeenCalled();
    expect(sharedState.applyingUpdate).toBe(false);
  });

  test('calls beforeReload before restartApp', async () => {
    const calls: string[] = [];
    const restartApp = mock(() => {
      calls.push('restartApp');
      return Promise.resolve();
    });
    const beforeReload = mock(async (context: any) => {
      calls.push('beforeReload');
      expect(context).toEqual({
        type: 'restartApp',
      });
    });
    setupClientMocks({ restartApp });

    const { Pushy } = await importFreshClient('before-reload-restart-app');
    const client = new Pushy({
      appKey: 'demo-app',
      beforeReload,
    });

    await client.restartApp();

    expect(calls).toEqual(['beforeReload', 'restartApp']);
    expect(restartApp).toHaveBeenCalled();
  });
});

describe('downloadUpdate fallback chain', () => {
  const realSetTimeout = globalThis.setTimeout;

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  const setupDownloadMocks = ({
    downloadPatchFromPpk = mock(() => Promise.resolve()),
    downloadPatchFromPackage = mock(() => Promise.resolve()),
    downloadFullUpdate = mock(() => Promise.resolve()),
  }: {
    downloadPatchFromPpk?: ReturnType<typeof mock>;
    downloadPatchFromPackage?: ReturnType<typeof mock>;
    downloadFullUpdate?: ReturnType<typeof mock>;
  } = {}) => {
    setupClientMocks({
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    });

    // Override setTimeout to skip real backoff delays in retry tests
    globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number) =>
      realSetTimeout(fn, 0)) as unknown as typeof setTimeout;

    // Mock testUrls to return urls directly (skip actual HEAD ping)
    mock.module('../utils', () => ({
      __esModule: true,
      assertWeb: () => true,
      computeProgress: (received: number, total: number) =>
        total > 0 ? Math.floor((received / total) * 100) : 0,
      DEFAULT_FETCH_TIMEOUT_MS: 5000,
      emptyObj: {},
      fetchWithTimeout: mock(() => Promise.resolve()),
      info: mock(() => {}),
      joinUrls: (paths: string[], fileName?: string) =>
        fileName ? paths.map(p => `${p}/${fileName}`) : undefined,
      log: mock(() => {}),
      noop: () => {},
      promiseAny: mock(() => Promise.resolve()),
      testUrls: (urls?: string[]) =>
        Promise.resolve(urls?.[0] || null),
    }));

    return { downloadPatchFromPpk, downloadPatchFromPackage, downloadFullUpdate };
  };

  const updateInfo = {
    update: true as const,
    hash: 'new-hash',
    diff: 'diff.ppk',
    pdiff: 'pdiff.ppk',
    full: 'full.ppk',
    paths: ['https://cdn.example.com'],
    name: 'v2.0',
    description: 'test update',
  };

  test('uses diff when available', async () => {
    const { downloadPatchFromPpk } = setupDownloadMocks();
    const { Pushy, sharedState } = await importFreshClient('dl-diff-ok');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app' });

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
  });

  test('falls back to pdiff when diff fails', async () => {
    const { downloadPatchFromPpk, downloadPatchFromPackage } =
      setupDownloadMocks({
        downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      });
    const { Pushy, sharedState } = await importFreshClient('dl-fallback-pdiff');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app' });

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(1);
  });

  test('falls back to full when diff and pdiff fail', async () => {
    const { downloadPatchFromPpk, downloadPatchFromPackage, downloadFullUpdate } =
      setupDownloadMocks({
        downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
        downloadPatchFromPackage: mock(() =>
          Promise.reject(Error('pdiff fail')),
        ),
      });
    const { Pushy, sharedState } = await importFreshClient('dl-fallback-full');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app' });

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(1);
    expect(downloadFullUpdate).toHaveBeenCalledTimes(1);
  });

  test('throws when all download methods fail', async () => {
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { Pushy, sharedState } = await importFreshClient('dl-all-fail');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app', maxRetries: 0 });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow(
      'error_full_patch_failed',
    );
  });

  test('retries download when maxRetries is set', async () => {
    let callCount = 0;
    const { downloadFullUpdate } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(Error('full fail attempt 1'));
        }
        return Promise.resolve();
      }),
    });
    const { Pushy, sharedState } = await importFreshClient('dl-retry-ok');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app', maxRetries: 2 });

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadFullUpdate).toHaveBeenCalledTimes(2);
  });

  test('defaults to 3 retries when maxRetries is not set', async () => {
    const { downloadFullUpdate } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { Pushy, sharedState } = await importFreshClient('dl-default-retries');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app' });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow();
    // 1 initial + 3 retries = 4 calls
    expect(downloadFullUpdate).toHaveBeenCalledTimes(4);
  });

  test('exhausts retries and throws on persistent failure', async () => {
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { Pushy, sharedState } = await importFreshClient('dl-retry-exhaust');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app', maxRetries: 2 });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow(
      'error_full_patch_failed',
    );
  });
});

describe('Cresc class', () => {
  test('uses Cresc server endpoints', async () => {
    setupClientMocks();

    const { Cresc } = await importFreshClient('cresc-endpoints');
    const client = new Cresc({ appKey: 'demo-app' });

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://api.cresc.dev',
      'https://api.cresc.app',
    ]);
  });

  test('defaults locale to en for Cresc', async () => {
    setupClientMocks();
    // Override i18n mock AFTER setupClientMocks to avoid being overwritten
    const setLocale = mock(() => {});
    mock.module('../i18n', () => ({
      default: {
        t: (key: string) => key,
        setLocale,
      },
    }));

    const { Cresc } = await importFreshClient('cresc-locale');
    const client = new Cresc({ appKey: 'demo-app' });

    expect(client.clientType).toBe('Cresc');
    expect(setLocale).toHaveBeenCalledWith('en');
  });

  test('Cresc is instance of Pushy', async () => {
    setupClientMocks();

    const { Cresc, Pushy } = await importFreshClient('cresc-instanceof');
    const client = new Cresc({ appKey: 'demo-app' });

    expect(client).toBeInstanceOf(Pushy);
    expect(client).toBeInstanceOf(Cresc);
  });

  test('Cresc custom server overrides default endpoints', async () => {
    setupClientMocks();

    const { Cresc } = await importFreshClient('cresc-custom-server');
    const client = new Cresc({
      appKey: 'demo-app',
      server: {
        main: ['https://custom.example.com'],
        queryUrls: ['https://q.example.com'],
      },
    });

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://custom.example.com',
    ]);
    expect(client.options.server?.queryUrls).toEqual([
      'https://q.example.com',
    ]);
  });
});
