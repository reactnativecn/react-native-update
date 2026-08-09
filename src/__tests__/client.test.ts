import { afterEach, describe, expect, mock, test } from 'bun:test';

const importFreshClient = (cacheKey: string) => import(`../client?${cacheKey}`);

const originalDev = (globalThis as any).__DEV__;

// Module mocks and mock.restore() are handled globally in setup.ts.
afterEach(() => {
  (globalThis as any).__DEV__ = originalDev;
});

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
  addProgressListener = mock(() => ({ remove: mock(() => {}) })),
  restartApp = mock(() => Promise.resolve()),
  // null simulates an older native module without the method (undefined would
  // just re-trigger this default).
  resetToPackagedBundle = mock(() => Promise.resolve()),
  // 原生上报的可消费 diff 轨道版本;0 模拟旧原生(不上报 diffV)
  supportedDiffVersion = 2,
  // 内嵌 bundle 的 sha256(core 层同步读预取值);'' 模拟未知
  getBundleHash = mock(() => ''),
  // undefined 模拟旧原生(无该方法,feature-detect 静默跳过)
  syncNativeConfig = undefined,
  getNativeCheckCache = undefined,
}: {
  isFirstTime?: boolean;
  markSuccess?: ReturnType<typeof mock>;
  reloadUpdate?: ReturnType<typeof mock>;
  setNeedUpdate?: ReturnType<typeof mock>;
  downloadPatchFromPpk?: ReturnType<typeof mock>;
  downloadPatchFromPackage?: ReturnType<typeof mock>;
  downloadFullUpdate?: ReturnType<typeof mock>;
  addProgressListener?: ReturnType<typeof mock>;
  restartApp?: ReturnType<typeof mock>;
  resetToPackagedBundle?: ReturnType<typeof mock> | null;
  supportedDiffVersion?: number;
  getBundleHash?: ReturnType<typeof mock>;
  syncNativeConfig?: ReturnType<typeof mock>;
  getNativeCheckCache?: ReturnType<typeof mock>;
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
      resetToPackagedBundle,
      ...(syncNativeConfig ? { syncNativeConfig } : {}),
      ...(getNativeCheckCache ? { getNativeCheckCache } : {}),
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
      addListener: addProgressListener,
    },
    rolledBackVersion: '',
    setLocalHashInfo: mock(() => {}),
    supportedDiffVersion,
    getBundleHash,
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

const setupAndroidApkMocks = (
  downloadAndInstallApk: ReturnType<typeof mock>
) => {
  (globalThis as any).__DEV__ = false;

  mock.module('react-native', () => ({
    Platform: {
      OS: 'android',
      Version: 30,
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
      downloadAndInstallApk,
      restartApp: mock(() => Promise.resolve()),
    },
    buildTime: '2023-01-01',
    cInfo: { rnu: '10.0.0', rn: '0.73.0', os: 'android', uuid: 'uuid' },
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
    supportedDiffVersion: 2,
    getBundleHash: mock(() => ''),
  }));

  mock.module('../permissions', () => ({
    PermissionsAndroid: {
      request: mock(() => Promise.resolve('granted')),
      PERMISSIONS: { WRITE_EXTERNAL_STORAGE: 'WRITE_EXTERNAL_STORAGE' },
      RESULTS: { GRANTED: 'granted' },
    },
  }));

  mock.module('../i18n', () => ({
    default: { t: (key: string) => key, setLocale: mock(() => {}) },
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
      ])
    );

    const { Pushy } = await importFreshClient('remote-main-array');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.getRemoteEndpoints()).toEqual([
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

  test('report delivers to a logger provided later via setOptions (JS-20)', async () => {
    setupClientMocks();
    const logger = mock(() => {});

    const { Pushy } = await importFreshClient('report-late-logger');
    const client = new Pushy({ appKey: 'demo-app' });

    const reportPromise = (client as any).report({ type: 'markSuccess' });
    expect(logger).not.toHaveBeenCalled();

    client.setOptions({ logger });
    await reportPromise;

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'markSuccess' })
    );
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
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(checkResult)
    );

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

  test('reports the native diff track version as diffV in the check body', async () => {
    setupClientMocks({ supportedDiffVersion: 2 });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { Pushy } = await importFreshClient('check-body-diffv');
    await new Pushy({ appKey: 'demo-app' }).checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body.diffV).toBe(2);
  });

  test('omits diffV when the native module reports no diff track support', async () => {
    setupClientMocks({ supportedDiffVersion: 0 });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { Pushy } = await importFreshClient('check-body-no-diffv');
    await new Pushy({ appKey: 'demo-app' }).checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body).not.toHaveProperty('diffV');
  });

  test('reports the embedded bundle hash as bundleHash in the check body', async () => {
    setupClientMocks({ getBundleHash: mock(() => 'a'.repeat(64)) });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { Pushy } = await importFreshClient('check-body-bundlehash');
    await new Pushy({ appKey: 'demo-app' }).checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body.bundleHash).toBe('a'.repeat(64));
  });

  test('omits bundleHash while the hash is unknown', async () => {
    // '' covers "not computed yet" (first launch), debug builds, older native
    // modules and missing embedded bundles alike; the check proceeds without
    // the field and the server falls back to the buildTime heuristic.
    setupClientMocks({ getBundleHash: mock(() => '') });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { Pushy } = await importFreshClient('check-body-no-bundlehash');
    await new Pushy({ appKey: 'demo-app' }).checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body).not.toHaveProperty('bundleHash');
  });

  test('surfaces an unknownBundle verdict through the logger as bundleMismatch', async () => {
    setupClientMocks({ getBundleHash: mock(() => 'b'.repeat(64)) });
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true, bundleStatus: 'unknownBundle' })
    );

    const { Pushy } = await importFreshClient('check-unknown-bundle');
    const events: any[] = [];
    const client = new Pushy({
      appKey: 'demo-app',
      logger: (event: any) => events.push(event),
    });
    const result = await client.checkUpdate();

    expect(result?.bundleStatus).toBe('unknownBundle');
    const mismatch = events.find((event) => event.type === 'bundleMismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch.data.bundleHash).toBe('b'.repeat(64));
  });

  test('matched bundleStatus stays silent', async () => {
    setupClientMocks({ getBundleHash: mock(() => 'c'.repeat(64)) });
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true, bundleStatus: 'matched' })
    );

    const { Pushy } = await importFreshClient('check-matched-bundle');
    const events: any[] = [];
    const client = new Pushy({
      appKey: 'demo-app',
      logger: (event: any) => events.push(event),
    });
    await client.checkUpdate();

    expect(events.some((event) => event.type === 'bundleMismatch')).toBe(false);
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
      })
    ).resolves.toBeUndefined();

    expect(downloadPatchFromPpk).not.toHaveBeenCalled();
    expect(downloadPatchFromPackage).not.toHaveBeenCalled();
    expect(downloadFullUpdate).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'downloading',
      })
    );
  });

  test('waits for native markSuccess before logging success', async () => {
    let resolveNativeMarkSuccess = () => {};
    const nativeMarkSuccess = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveNativeMarkSuccess = resolve;
        })
    );
    const logger = mock(() => {});
    setupClientMocks({
      isFirstTime: true,
      markSuccess: nativeMarkSuccess,
    });

    const { Pushy, sharedState } = await importFreshClient(
      'mark-success-awaits-native'
    );
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
      })
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

    const { Pushy, sharedState } = await importFreshClient(
      'before-reload-switch-version'
    );
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

    const { Pushy, sharedState } = await importFreshClient(
      'before-reload-skip-switch'
    );
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

describe('error pipeline (onError + stable codes, EH-1/EH-2/EH-3)', () => {
  test('check failure emits a coded error to onError listeners without throwing (throwError:false)', async () => {
    setupClientMocks();
    const logger = mock(() => {});
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });

    const { Pushy } = await importFreshClient('pipeline-check-failed');
    const client = new Pushy({ appKey: 'demo-app', logger });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    // Default throwError:false — resolves undefined instead of throwing.
    expect(await client.checkUpdate()).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorChecking');
    expect(seen[0].e.code).toBe('CHECK_FAILED');
    expect(seen[0].e.message).toBe('offline');
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorChecking',
        data: expect.objectContaining({ code: 'CHECK_FAILED' }),
      })
    );
  });

  test('onError unsubscribe stops delivery', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });

    const { Pushy } = await importFreshClient('pipeline-unsubscribe');
    const client = new Pushy({ appKey: 'demo-app' });
    const listener = mock(() => {});
    const unsubscribe = client.onError(listener);
    unsubscribe();

    await client.checkUpdate();
    expect(listener).not.toHaveBeenCalled();
  });

  test('switchVersion failure is reported as errorSwitchVersion and rethrown (EH-3)', async () => {
    const reloadUpdate = mock(() => Promise.reject(Error('bundle missing')));
    const logger = mock(() => {});
    setupClientMocks({ reloadUpdate });

    const { Pushy, sharedState } = await importFreshClient(
      'pipeline-switch-version-failed'
    );
    sharedState.downloadedHash = 'next-hash';
    sharedState.applyingUpdate = false;
    const client = new Pushy({ appKey: 'demo-app', logger });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'bundle missing'
    );

    expect(sharedState.applyingUpdate).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorSwitchVersion');
    expect(seen[0].e.code).toBe('SWITCH_VERSION_FAILED');
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorSwitchVersion',
        data: expect.objectContaining({
          code: 'SWITCH_VERSION_FAILED',
          newVersion: 'next-hash',
        }),
      })
    );
  });

  test('a native-provided rejection code is preserved, not overwritten by the JS fallback (EH-5)', async () => {
    // Native modules reject with stable codes from cpp/patch_core/error_codes.h
    // (e.g. INVALID_OPTIONS); toUpdateError must keep them instead of stamping
    // the JS-layer fallback code on top.
    const nativeError: any = Error('empty hash');
    nativeError.code = 'INVALID_OPTIONS';
    const reloadUpdate = mock(() => Promise.reject(nativeError));
    setupClientMocks({ reloadUpdate });

    const { Pushy, sharedState } = await importFreshClient(
      'pipeline-native-code-preserved'
    );
    sharedState.downloadedHash = 'next-hash';
    sharedState.applyingUpdate = false;
    const client = new Pushy({ appKey: 'demo-app' });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'empty hash'
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].e.code).toBe('INVALID_OPTIONS');
  });

  test('a beforeReload hook throw gets USER_HOOK_ERROR, distinct from pipeline failures (JS2-3)', async () => {
    setupClientMocks();
    const { Pushy, sharedState } = await importFreshClient(
      'pipeline-user-hook-error'
    );
    sharedState.downloadedHash = 'next-hash';
    sharedState.applyingUpdate = false;
    const client = new Pushy({
      appKey: 'demo-app',
      beforeReload: () => {
        throw new Error('hook exploded');
      },
    });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'hook exploded'
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorSwitchVersion');
    // Distinct code: telemetry excludes USER_HOOK_ERROR from server-side
    // patch-health stats (a hook bug is not a bad patch).
    expect(seen[0].e.code).toBe('USER_HOOK_ERROR');
    expect(sharedState.applyingUpdate).toBe(false);
  });

  test('concurrent checkUpdate reusing a failing in-flight check keeps its contracts (JS2-1)', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });
    const { Pushy } = await importFreshClient('pipeline-check-cache-error');
    const states: any[] = [];
    const client = new Pushy({
      appKey: 'demo-app',
      afterCheckUpdate: (state: any) => {
        states.push(state);
      },
    });

    // The second call starts inside the 5s window and awaits the first
    // call's in-flight promise (the cache path). Before the fix it rejected
    // raw, bypassing throwError:false and afterCheckUpdate entirely.
    const first = client.checkUpdate();
    const second = client.checkUpdate();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();

    // "Every check ends with a notification" — both calls, both as errors.
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.status === 'error')).toBe(true);
  });

  test('apk download failure keeps the native error and reports its message (EH-4)', async () => {
    const downloadAndInstallApk = mock(() =>
      Promise.reject(Error('disk full'))
    );
    const logger = mock(() => {});
    setupAndroidApkMocks(downloadAndInstallApk);

    const { Pushy, sharedState } =
      await importFreshClient('pipeline-apk-cause');
    sharedState.apkStatus = null;
    const client = new Pushy({ appKey: 'demo-app', logger });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await client.downloadAndInstallApk('https://example.com/app.apk');

    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorDownloadAndInstallApk');
    expect(seen[0].e.code).toBe('APK_DOWNLOAD_FAILED');
    // The original native error must not be discarded anymore.
    expect(seen[0].e.message).toBe('disk full');
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorDownloadAndInstallApk',
        data: expect.objectContaining({
          code: 'APK_DOWNLOAD_FAILED',
          message: 'disk full',
        }),
      })
    );
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
    addProgressListener = mock(() => ({ remove: mock(() => {}) })),
  }: {
    downloadPatchFromPpk?: ReturnType<typeof mock>;
    downloadPatchFromPackage?: ReturnType<typeof mock>;
    downloadFullUpdate?: ReturnType<typeof mock>;
    addProgressListener?: ReturnType<typeof mock>;
  } = {}) => {
    setupClientMocks({
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
      addProgressListener,
    });

    // Override setTimeout to skip real backoff delays in retry tests
    globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number) =>
      realSetTimeout(fn, 0)) as unknown as typeof setTimeout;

    // Mock testUrls to return urls directly (skip actual HEAD ping)
    mock.module('../utils', () => ({
      __esModule: true,
      assertWeb: () => true,
      computeProgress: (received: number, total: number) =>
        total > 0
          ? Math.min(100, Math.max(0, Math.floor((received / total) * 100)))
          : 0,
      DEFAULT_FETCH_TIMEOUT_MS: 5000,
      emptyObj: {},
      fetchWithTimeout: mock(() => Promise.resolve()),
      info: mock(() => {}),
      joinUrls: (paths: string[], fileName?: string) =>
        fileName ? paths.map((p) => `${p}/${fileName}`) : undefined,
      log: mock(() => {}),
      noop: () => {},
      promiseAny: mock(() => Promise.resolve()),
      testUrls: (urls?: string[]) => Promise.resolve(urls?.[0] || null),
    }));

    return {
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    };
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

  test('adds computed progress to download progress callbacks', async () => {
    let progressListener:
      | ((data: { hash: string; received: number; total: number }) => void)
      | undefined;
    const addProgressListener = mock(
      (_event: string, listener: typeof progressListener) => {
        progressListener = listener;
        return { remove: mock(() => {}) };
      }
    );
    const onDownloadProgress = mock(() => {});
    setupDownloadMocks({
      addProgressListener,
      downloadPatchFromPpk: mock(async () => {
        progressListener?.({
          hash: 'new-hash',
          received: 1200,
          total: 1000,
        });
      }),
    });
    const { Pushy, sharedState } = await importFreshClient('dl-progress');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app' });

    await client.downloadUpdate(updateInfo, onDownloadProgress);

    expect(onDownloadProgress).toHaveBeenCalledWith({
      hash: 'new-hash',
      received: 1200,
      total: 1000,
      progress: 100,
    });
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
    const {
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
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
      'error_full_patch_failed'
    );
  });

  test('treats negative maxRetries as zero retries', async () => {
    const { downloadFullUpdate } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { Pushy, sharedState } = await importFreshClient(
      'dl-negative-retries'
    );
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app', maxRetries: -1 });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow(
      'error_full_patch_failed'
    );
    expect(downloadFullUpdate).toHaveBeenCalledTimes(1);
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
    const { Pushy, sharedState } =
      await importFreshClient('dl-default-retries');
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
      'error_full_patch_failed'
    );
  });

  test('all-strategies failure carries the DOWNLOAD_FAILED code (EH-1)', async () => {
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { Pushy, sharedState } = await importFreshClient('dl-failed-code');
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app', maxRetries: 0 });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    const err: any = await client
      .downloadUpdate(updateInfo)
      .catch((e: any) => e);

    expect(err.code).toBe('DOWNLOAD_FAILED');
    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorUpdate');
    expect(seen[0].e).toBe(err);
  });

  test('a native PATCH_FAILED rejection survives to the thrown error (JS2-2)', async () => {
    // Before the fix, the strategy loop re-created a plain Error from the
    // i18n message, dropping the native code — telemetry then classified
    // every failure as download_fail and patch_fail never fired.
    const patchError: any = Error('hpatch failed');
    patchError.code = 'PATCH_FAILED';
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(patchError)),
    });
    const { Pushy, sharedState } = await importFreshClient(
      'dl-patch-failed-code'
    );
    sharedState.downloadedHash = undefined;
    const client = new Pushy({ appKey: 'demo-app', maxRetries: 0 });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    const err: any = await client
      .downloadUpdate(updateInfo)
      .catch((e: any) => e);

    expect(err.code).toBe('PATCH_FAILED');
    expect(err.cause).toBe(patchError);
    expect(seen[0].e.code).toBe('PATCH_FAILED');
  });

  test('deduplicates concurrent downloads of the same hash (JS-8)', async () => {
    // A slow native download keeps the first call in-flight while the second
    // starts, so the dedup must reuse the same promise instead of triggering a
    // second native download.
    let resolveDownload: (() => void) | undefined;
    const downloadFullUpdate = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        })
    );
    setupDownloadMocks({ downloadFullUpdate });
    const { Pushy, sharedState } = await importFreshClient(
      'dl-concurrent-dedup'
    );
    sharedState.downloadedHash = undefined;
    // Only a full URL so the full strategy is the one exercised.
    const fullOnlyInfo = {
      update: true as const,
      hash: 'new-hash',
      full: 'full.ppk',
      paths: ['https://cdn.example.com'],
      name: 'v2.0',
      description: 'test update',
    };
    // No onDownloadProgress passed — old code only deduped when a progress
    // handler was registered, so this exercises the new promise-table dedup.
    const client = new Pushy({ appKey: 'demo-app' });

    const first = client.downloadUpdate(fullOnlyInfo);
    const second = client.downloadUpdate(fullOnlyInfo);
    // Let both calls reach the (single) native download, then let it finish.
    await new Promise((r) => setTimeout(r, 10));
    resolveDownload?.();
    const [firstHash, secondHash] = await Promise.all([first, second]);

    expect(firstHash).toBe('new-hash');
    expect(secondHash).toBe('new-hash');
    expect(downloadFullUpdate).toHaveBeenCalledTimes(1);
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

  test('explicit locale option overrides clientType default', async () => {
    setupClientMocks();
    const setLocale = mock(() => {});
    mock.module('../i18n', () => ({
      default: {
        t: (key: string) => key,
        setLocale,
      },
    }));

    const { Pushy } = await importFreshClient('pushy-locale-override');
    // Pushy defaults to 'zh'; an explicit 'en' must win.
    new Pushy({ appKey: 'demo-app', locale: 'en' });

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
    expect(client.options.server?.queryUrls).toEqual(['https://q.example.com']);
  });
});

describe('resetToPackagedBundle', () => {
  test('calls native reset and clears JS download bookkeeping', async () => {
    const resetToPackagedBundle = mock(() => Promise.resolve());
    const restartApp = mock(() => Promise.resolve());
    setupClientMocks({ resetToPackagedBundle, restartApp });
    const { Pushy, sharedState } = await importFreshClient('reset-basic');
    sharedState.downloadedHash = 'stale-hash';
    sharedState.marked = true;
    const client = new Pushy({ appKey: 'demo-app' });

    const result = await client.resetToPackagedBundle();

    expect(result).toBe(true);
    expect(resetToPackagedBundle).toHaveBeenCalledTimes(1);
    expect(sharedState.downloadedHash).toBeUndefined();
    expect(sharedState.marked).toBe(false);
    // No restart unless explicitly requested.
    expect(restartApp).not.toHaveBeenCalled();
  });

  test('restart: true reloads the app after the reset', async () => {
    const resetToPackagedBundle = mock(() => Promise.resolve());
    const restartApp = mock(() => Promise.resolve());
    setupClientMocks({ resetToPackagedBundle, restartApp });
    const { Pushy } = await importFreshClient('reset-restart');
    const client = new Pushy({ appKey: 'demo-app' });

    await client.resetToPackagedBundle({ restart: true });

    expect(resetToPackagedBundle).toHaveBeenCalledTimes(1);
    expect(restartApp).toHaveBeenCalledTimes(1);
  });

  test('resolves false with RESET_FAILED via onError when the native module lacks the method', async () => {
    // Simulates new JS arriving via hot update onto an older binary. Like the
    // other update-flow APIs this must not throw by default.
    setupClientMocks({ resetToPackagedBundle: null });
    const { Pushy } = await importFreshClient('reset-unsupported');
    const client = new Pushy({ appKey: 'demo-app' });
    const seen: any[] = [];
    client.onError((err: any) => seen.push(err));

    const result = await client.resetToPackagedBundle();

    expect(result).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe('RESET_FAILED');
  });

  test('throwError option makes an unsupported reset throw', async () => {
    setupClientMocks({ resetToPackagedBundle: null });
    const { Pushy } = await importFreshClient('reset-unsupported-throw');
    const client = new Pushy({ appKey: 'demo-app', throwError: true });

    await expect(client.resetToPackagedBundle()).rejects.toMatchObject({
      code: 'RESET_FAILED',
    });
  });

  test('resolves false on native failure and keeps state', async () => {
    const resetToPackagedBundle = mock(() =>
      Promise.reject(Error('disk full'))
    );
    setupClientMocks({ resetToPackagedBundle });
    const { Pushy, sharedState } = await importFreshClient('reset-native-fail');
    sharedState.downloadedHash = 'stale-hash';
    const client = new Pushy({ appKey: 'demo-app' });
    const seen: any[] = [];
    client.onError((err: any) => seen.push(err));

    const result = await client.resetToPackagedBundle();

    expect(result).toBe(false);
    expect(seen[0].code).toBe('RESET_FAILED');
    expect(seen[0].message).toBe('disk full');
    // The native reset did not happen, so the bookkeeping must not be wiped.
    expect(sharedState.downloadedHash).toBe('stale-hash');
  });
});

describe('downloadAndInstallApk apkStatus (JS-3)', () => {
  test('resets apkStatus after a failed download so retry is possible', async () => {
    // First download fails, second succeeds. The old code unconditionally set
    // apkStatus='downloaded' after a caught failure, permanently blocking retry.
    let callCount = 0;
    const downloadAndInstallApk = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(Error('download fail'));
      }
      return Promise.resolve();
    });
    setupAndroidApkMocks(downloadAndInstallApk);
    const { Pushy, sharedState } = await importFreshClient('apk-retry');
    sharedState.apkStatus = null;
    const client = new Pushy({ appKey: 'demo-app' });

    await client.downloadAndInstallApk('https://example.com/app.apk');
    // Failure must leave apkStatus reset (null), not stuck at 'downloaded'.
    expect(sharedState.apkStatus).toBe(null);

    // A retry should now proceed and reach the native module a second time.
    await client.downloadAndInstallApk('https://example.com/app.apk');
    expect(downloadAndInstallApk).toHaveBeenCalledTimes(2);
    expect(sharedState.apkStatus).toBe('downloaded');
  });
});

describe('client singleton', () => {
  test('a second client with a different appKey throws SINGLETON_VIOLATION', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient('singleton-different-appkey');
    const client1 = new Pushy({ appKey: 'app-1' });
    expect(client1.options.appKey).toBe('app-1');

    let error: any;
    try {
      new Pushy({ appKey: 'app-2' });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('SINGLETON_VIOLATION');
  });

  test('a Cresc client after a Pushy client throws SINGLETON_VIOLATION', async () => {
    setupClientMocks();
    const { Pushy, Cresc } = await importFreshClient('singleton-cross-type');
    new Pushy({ appKey: 'app-1' });

    let error: any;
    try {
      new Cresc({ appKey: 'app-1' });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('SINGLETON_VIOLATION');
  });

  test('re-creating the same client is idempotent and applies the new options', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient('singleton-idempotent');
    const client1 = new Pushy({ appKey: 'app-1', debug: true });
    // e.g. dev fast refresh re-running the module that builds the client
    const client2 = new Pushy({
      appKey: 'app-1',
      updateStrategy: 'silentAndNow',
    });

    expect(client2).toBe(client1);
    expect(client1.options.debug).toBe(true);
    expect(client1.options.updateStrategy).toBe('silentAndNow');
  });

  test('setOptions bumps optionsVersion and notifies subscribers', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient('singleton-options-version');
    const client = new Pushy({ appKey: 'app-1' });
    const initialVersion = client.optionsVersion;
    const listener = mock(() => {});
    const unsubscribe = client.onOptionsChange(listener);

    client.setOptions({ updateStrategy: 'alwaysAlert' });
    expect(client.optionsVersion).toBe(initialVersion + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    client.setOptions({ updateStrategy: 'silentAndNow' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a second concurrent provider mount claim throws SINGLETON_VIOLATION', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient('singleton-provider-claim');
    const client = new Pushy({ appKey: 'app-1' });

    const release = client.claimProviderMount();
    let error: any;
    try {
      client.claimProviderMount();
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('SINGLETON_VIOLATION');

    // After unmount the claim is released and a new provider may mount.
    release();
    expect(() => client.claimProviderMount()).not.toThrow();
  });
});

describe('syncNativeConfig', () => {
  test('persists the native check config on construction (silent strategy activates)', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient('sync-config-1');
    new Pushy({ appKey: 'demo-app', updateStrategy: 'silentAndLater' });

    expect(syncNativeConfig).toHaveBeenCalled();
    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.appKey).toBe('demo-app');
    expect(config.afterDownload).toBe('setNeedUpdate');
    expect(config.endpoints.length).toBeGreaterThan(0);
    expect(config.queryUrls.length).toBeGreaterThan(0);
    expect(config.rnu).toBe('10.0.0');
    expect(config.rn).toBe('0.73.0');
    expect(config.packageVersion).toBe('1.0.0');
  });

  test('alert strategies keep activation with JS (afterDownload none)', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient('sync-config-2');
    new Pushy({ appKey: 'demo-app' });

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('none');
  });

  test('setOptions re-syncs when the strategy changes', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient('sync-config-3');
    const client = new Pushy({ appKey: 'demo-app' });
    client.setOptions({ updateStrategy: 'silentAndNow' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('setNeedUpdate');
  });

  test('persists and exposes the effective overridden package version', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient('sync-config-package-override');
    const client = new Pushy({
      appKey: 'demo-app',
      overridePackageVersion: '9.9.9',
    });

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.packageVersion).toBe('9.9.9');
    expect(client.getEffectivePackageVersion()).toBe('9.9.9');
  });

  test('skips duplicate config writes after the same value succeeds', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient('sync-config-dedupe');
    const client = new Pushy({ appKey: 'demo-app' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    client.setOptions({ appKey: 'demo-app' });

    expect(syncNativeConfig).toHaveBeenCalledTimes(1);
  });

  test('serializes config writes and preserves the newest pending value', async () => {
    const resolvers: Array<() => void> = [];
    const syncNativeConfig = mock(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient('sync-config-serialized');
    const client = new Pushy({ appKey: 'demo-app' });

    client.setOptions({ updateStrategy: 'silentAndNow' });
    expect(syncNativeConfig).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(syncNativeConfig).toHaveBeenCalledTimes(2);
    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('setNeedUpdate');
    resolvers[1]();
  });

  test('retries a config write that failed', async () => {
    let calls = 0;
    const syncNativeConfig = mock(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('write failed'))
        : Promise.resolve();
    });
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient('sync-config-retry');
    const client = new Pushy({ appKey: 'demo-app' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    client.setOptions({ appKey: 'demo-app' });

    expect(syncNativeConfig).toHaveBeenCalledTimes(2);
  });

  test('an older native module without the method is skipped silently', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient('sync-config-4');
    // Must not throw even though PushyModule lacks syncNativeConfig.
    new Pushy({ appKey: 'demo-app' });
  });
});

describe('native check cache reuse', () => {
  const expectedRequestBody = JSON.stringify({
    packageVersion: '1.0.0',
    hash: 'hash',
    buildTime: '2023-01-01',
    cInfo: {
      rnu: '10.0.0',
      rn: '0.73.0',
      os: 'ios',
      uuid: 'uuid',
    },
    diffV: 2,
  });

  test('a fresh cached response is reused without a network check', async () => {
    const cachedResult = { upToDate: true };
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 30,
          body: JSON.stringify(cachedResult),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    // setup.ts's default fetch throws, so any network attempt would surface
    // as a failed check (undefined) instead of the cached result.
    const { Pushy } = await importFreshClient('native-cache-fresh');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.checkUpdate()).toEqual(cachedResult);
    expect(getNativeCheckCache).toHaveBeenCalled();
  });

  test('a stale cached response falls through to the network', async () => {
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 600,
          body: JSON.stringify({ upToDate: true }),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'net-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { Pushy } = await importFreshClient('native-cache-stale');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.checkUpdate()).toEqual(networkResult);
  });

  test('an unreadable cache never breaks the check', async () => {
    const getNativeCheckCache = mock(() => Promise.resolve('not json'));
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { upToDate: true };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { Pushy } = await importFreshClient('native-cache-bad');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.checkUpdate()).toEqual(networkResult);
  });

  test('a cache for a different request body is never reused', async () => {
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify({ hash: 'wrong-hash', update: true }),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'requested-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { Pushy } = await importFreshClient('native-cache-request-key');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.checkUpdate({ toHash: 'requested-hash' })).toEqual(
      networkResult
    );
  });

  test('request key order does not prevent reuse of the same request', async () => {
    const cachedResult = { upToDate: true };
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify(cachedResult),
          request: JSON.stringify({
            diffV: 2,
            cInfo: {
              uuid: 'uuid',
              os: 'ios',
              rn: '0.73.0',
              rnu: '10.0.0',
            },
            buildTime: '2023-01-01',
            hash: 'hash',
            packageVersion: '1.0.0',
          }),
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const { Pushy } = await importFreshClient('native-cache-key-order');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.checkUpdate()).toEqual(cachedResult);
  });

  test('a cache for a different native config is never reused', async () => {
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify({ upToDate: true }),
          request: expectedRequestBody,
          config: JSON.stringify({ appKey: 'another-app' }),
        })
      )
    );
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'net-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { Pushy } = await importFreshClient('native-cache-config-key');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.checkUpdate()).toEqual(networkResult);
  });

  test('a cache timestamp from the future is never reused', async () => {
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) + 600,
          body: JSON.stringify({ upToDate: true }),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'net-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { Pushy } = await importFreshClient('native-cache-future');
    const client = new Pushy({ appKey: 'demo-app' });

    expect(await client.checkUpdate()).toEqual(networkResult);
  });
});
