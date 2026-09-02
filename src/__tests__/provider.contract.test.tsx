/**
 * Provider <-> client contract, exercised with the REAL Pushy client (only
 * the native module / core constants are mocked, as in client.test.ts). The
 * render tests next door use a hand-written fake client; this file is what
 * keeps that fake honest about the members the provider actually relies on.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import type React from 'react';
import TestRenderer from 'react-test-renderer';
import { emitAppStateChange, mockAlert } from './setup';

// Release code paths (assertDebug allows checks, default strategies apply).
const _origDEV = (globalThis as any).__DEV__;
(globalThis as any).__DEV__ = false;

const { useUpdate } = await import('../context');

const createJsonResponse = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }) as Response;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let importSeq = 0;

// A fresh client module per test: the client is a process-level singleton
// (module state), so every test gets its own module instance instead of
// inheriting the previous test's options, listeners and dedup window.
const setupRealClient = async (
  options: Record<string, any> = {},
  native: { markSuccess?: ReturnType<typeof mock>; isFirstTime?: boolean } = {}
) => {
  const seq = ++importSeq;
  mock.module('../core', () => ({
    PushyModule: {
      markSuccess: native.markSuccess ?? mock(() => Promise.resolve()),
      reloadUpdate: mock(() => Promise.resolve()),
      setNeedUpdate: mock(() => Promise.resolve()),
      downloadPatchFromPpk: mock(() => Promise.resolve()),
      downloadPatchFromPackage: mock(() => Promise.resolve()),
      downloadFullUpdate: mock(() => Promise.resolve()),
      downloadAndInstallApk: mock(() => Promise.resolve()),
      restartApp: mock(() => Promise.resolve()),
      resetToPackagedBundle: mock(() => Promise.resolve()),
    },
    buildTime: '2023-01-01',
    cInfo: { rnu: '10.0.0', rn: '0.73.0', os: 'ios', uuid: 'uuid' },
    currentVersion: 'hash',
    currentVersionInfo: {},
    isFirstTime: native.isFirstTime ?? false,
    isRolledBack: false,
    packageVersion: '1.0.0',
    pushyNativeEventEmitter: {
      addListener: mock(() => ({ remove: mock(() => {}) })),
    },
    rolledBackVersion: '',
    setLocalHashInfo: mock(() => {}),
    supportedDiffVersion: 2,
    getBundleHash: mock(() => ''),
    getCurrentVersionInfo: async () => ({}),
  }));
  mock.module('../i18n', () => ({
    default: {
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}${JSON.stringify(params)}` : key,
      setLocale: mock(() => {}),
    },
  }));
  const { Pushy } = await import(`../client?contract-${seq}`);
  const { UpdateProvider } = await import(`../provider?contract-${seq}`);
  const client = new Pushy({ appKey: 'contract-app', ...options });
  // Count the provider's calls into the client without changing what they do.
  const realCheckUpdate = client.checkUpdate;
  const checkUpdate = mock((extra?: Record<string, any>) =>
    realCheckUpdate(extra)
  );
  client.checkUpdate = checkUpdate;
  return { client, UpdateProvider, checkUpdate };
};

const renderProvider = async (
  UpdateProvider: React.ComponentType<any>,
  client: any,
  children?: React.ReactElement
) => {
  let renderer: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <UpdateProvider client={client}>{children ?? <></>}</UpdateProvider>
    );
    await flush();
  });
  return renderer!;
};

describe('UpdateProvider <-> Pushy contract', () => {
  beforeEach(() => {
    mockAlert.mockClear();
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true })
    );
  });

  afterAll(() => {
    (globalThis as any).__DEV__ = _origDEV;
  });

  test('a second concurrently mounted provider throws SINGLETON_VIOLATION', async () => {
    const { client, UpdateProvider } = await setupRealClient({
      checkStrategy: null,
    });
    await renderProvider(UpdateProvider, client);

    // React logs the uncaught effect error before rethrowing it.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    let thrown: any;
    try {
      TestRenderer.act(() => {
        TestRenderer.create(
          <UpdateProvider client={client}>
            <></>
          </UpdateProvider>
        );
      });
    } catch (e) {
      thrown = e;
    } finally {
      consoleError.mockRestore();
    }
    expect(thrown?.code).toBe('SINGLETON_VIOLATION');
  });

  test('unmount releases the claim, removes the AppState listener and clears the auto-mark timer', async () => {
    const markSuccess = mock(() => Promise.resolve());
    const { client, UpdateProvider, checkUpdate } = await setupRealClient(
      {
        checkStrategy: 'onAppResume',
        autoMarkSuccess: true,
        autoMarkSuccessDelayMs: 40,
      },
      { markSuccess, isFirstTime: true }
    );
    const renderer = await renderProvider(UpdateProvider, client);
    expect(checkUpdate).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      renderer.unmount();
    });
    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await sleep(80);
    expect(markSuccess).not.toHaveBeenCalled();

    // The claim was released: a new provider may mount.
    await renderProvider(UpdateProvider, client);
  });

  test("checkStrategy 'both' checks at mount and on every return to the foreground", async () => {
    const { client, UpdateProvider, checkUpdate } = await setupRealClient({
      checkStrategy: 'both',
    });
    await renderProvider(UpdateProvider, client);
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      emitAppStateChange('background');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(2);
  });

  test('setOptions after mount does not re-run the start check (1.2)', async () => {
    const { client, UpdateProvider, checkUpdate } = await setupRealClient({
      checkStrategy: 'onAppStart',
    });
    await renderProvider(UpdateProvider, client);
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      client.setOptions({ logger: () => {} });
      await flush();
    });
    await TestRenderer.act(async () => {
      client.setOptions({ disableErrorReporting: true });
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);
  });

  test('changing dismissErrorAfter reschedules a running dismiss timer', async () => {
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });
    const { client, UpdateProvider } = await setupRealClient({
      updateStrategy: 'alertUpdateAndIgnoreError',
      checkStrategy: 'onAppStart',
      dismissErrorAfter: 40,
    });
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(UpdateProvider, client, <Probe />);
    expect(captured.current.lastError?.code).toBe('CHECK_FAILED');

    await TestRenderer.act(async () => {
      client.setOptions({ dismissErrorAfter: 200 });
      await flush();
    });
    // The original 40ms would have fired by now; the new schedule has not.
    await TestRenderer.act(async () => {
      await sleep(80);
    });
    expect(captured.current.lastError).toBeTruthy();

    await TestRenderer.act(async () => {
      await sleep(200);
    });
    expect(captured.current.lastError).toBeUndefined();
  });
});
