import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import React, { useContext } from 'react';
import TestRenderer from 'react-test-renderer';
import { mockAlert, emitAppStateChange } from './setup';

// Render tests exercise the release code paths (assertDebug allows checks).
const _origDEV = (globalThis as any).__DEV__;
(globalThis as any).__DEV__ = false;

const { UpdateProvider } = await import('../provider');
const { UpdateContext, useUpdate, useUpdateProgress } = await import(
  '../context'
);
const { mock } = await import('bun:test');

import type { CheckResult, ProgressData } from '../type';

const updateResult: CheckResult = {
  update: true,
  name: '1.0.1',
  hash: 'next-hash',
  description: 'bugfix',
};

const createClient = (options: Record<string, any> = {}) => {
  let progressCallback: ((data: ProgressData) => void) | undefined;
  const errorListeners = new Set<(e: Error, eventType?: string) => void>();
  const client = {
    options: {
      updateStrategy: 'alwaysAlert',
      checkStrategy: 'onAppStart',
      autoMarkSuccess: false,
      ...options,
    },
    assertDebug: () => true,
    checkUpdate: mock(
      async (): Promise<CheckResult | undefined> => ({ ...updateResult }),
    ),
    notifyAfterCheckUpdate: mock(() => {}),
    markSuccess: mock(() => {}),
    switchVersion: mock(async () => {}),
    switchVersionLater: mock(async () => {}),
    downloadUpdate: mock(
      async (_info: CheckResult, onProgress?: (data: ProgressData) => void) => {
        progressCallback = onProgress;
        return 'next-hash';
      },
    ),
    downloadAndInstallApk: mock(async () => {}),
    restartApp: mock(async () => {}),
    t: (key: string) => key,
    onError: mock((listener: (e: Error, eventType?: string) => void) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    }),
    // Simulates the real client contract: errors are emitted to onError
    // listeners (report + lastError/Alert path) regardless of throwError.
    emitError: (e: Error, eventType = 'errorChecking') => {
      errorListeners.forEach(listener => listener(e, eventType));
    },
    emitProgress: (data: ProgressData) => progressCallback?.(data),
  };
  return client;
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const renderProvider = async (
  client: ReturnType<typeof createClient>,
  children?: React.ReactElement,
) => {
  let renderer: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <UpdateProvider client={client as any}>
        {children ?? <></>}
      </UpdateProvider>,
    );
    await flush();
  });
  return renderer!;
};

describe('UpdateProvider rendering', () => {
  beforeEach(() => {
    mockAlert.mockClear();
  });

  afterAll(() => {
    (globalThis as any).__DEV__ = _origDEV;
  });

  test('alwaysAlert strategy alerts when an update is found and downloads on confirm', async () => {
    const client = createClient({ updateStrategy: 'alwaysAlert' });
    await renderProvider(client);

    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = mockAlert.mock.calls[0] as any[];
    expect(title).toBe('alert_title');

    // Press "confirm" -> downloads, then shows the "update ready" alert.
    await TestRenderer.act(async () => {
      buttons[1].onPress();
      await flush();
    });
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mockAlert).toHaveBeenCalledTimes(2);
    const readyButtons = (mockAlert.mock.calls[1] as any[])[2];

    // Press "update now" -> switches version.
    await TestRenderer.act(async () => {
      readyButtons[1].onPress();
      await flush();
    });
    expect(client.switchVersion).toHaveBeenCalledWith('next-hash');
  });

  test('silentAndNow strategy downloads and switches without alerts', async () => {
    const client = createClient({ updateStrategy: 'silentAndNow' });
    await renderProvider(client);

    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(client.switchVersion).toHaveBeenCalledWith('next-hash');
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('silentAndLater strategy downloads and defers the switch', async () => {
    const client = createClient({ updateStrategy: 'silentAndLater' });
    await renderProvider(client);

    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(client.switchVersionLater).toHaveBeenCalledWith('next-hash');
    expect(client.switchVersion).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('check failure sets lastError and alerts under alwaysAlert', async () => {
    const client = createClient({ updateStrategy: 'alwaysAlert' });
    const checkError = new Error('offline');
    // Real client contract under the default throwError:false — the error is
    // emitted to onError listeners and checkUpdate resolves undefined.
    client.checkUpdate.mockImplementation(async () => {
      client.emitError(checkError, 'errorChecking');
      return undefined;
    });

    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(captured.current.lastError).toBe(checkError);
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect((mockAlert.mock.calls[0] as any[])[0]).toBe(
      'error_update_check_failed',
    );
  });

  test('alertUpdateAndIgnoreError suppresses the error alert but keeps lastError', async () => {
    const client = createClient({ updateStrategy: 'alertUpdateAndIgnoreError' });
    const checkError = new Error('offline');
    client.checkUpdate.mockImplementation(async () => {
      client.emitError(checkError, 'errorChecking');
      return undefined;
    });

    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(captured.current.lastError).toBe(checkError);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('dismissErrorAfter clears lastError automatically (JS-4 regression)', async () => {
    const client = createClient({
      updateStrategy: 'alertUpdateAndIgnoreError',
      dismissErrorAfter: 20,
    });
    client.checkUpdate.mockImplementation(async () => {
      client.emitError(new Error('offline'), 'errorChecking');
      return undefined;
    });

    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);
    expect(captured.current.lastError).toBeTruthy();

    await TestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    expect(captured.current.lastError).toBeUndefined();
  });

  test('onAppResume strategy checks when the app becomes active', async () => {
    const client = createClient({
      updateStrategy: 'silentAndLater',
      checkStrategy: 'onAppResume',
    });
    await renderProvider(client);
    expect(client.checkUpdate).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
  });

  test('progress ticks re-render progress consumers but not static context consumers (JS-7)', async () => {
    const client = createClient({ updateStrategy: 'silentAndLater' });

    let staticRenders = 0;
    const StaticProbe = () => {
      staticRenders++;
      useContext(UpdateContext);
      return null;
    };
    const progressSeen: ProgressData[] = [];
    const ProgressProbe = () => {
      const progress = useUpdateProgress();
      if (progress) {
        progressSeen.push(progress);
      }
      return null;
    };

    await renderProvider(
      client,
      <>
        <StaticProbe />
        <ProgressProbe />
      </>,
    );
    // Download has started (silentAndLater) and captured the progress callback.
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);

    const staticRendersBefore = staticRenders;
    await TestRenderer.act(async () => {
      client.emitProgress({ hash: 'next-hash', received: 1, total: 10 });
      await flush();
    });
    await TestRenderer.act(async () => {
      client.emitProgress({ hash: 'next-hash', received: 5, total: 10 });
      await flush();
    });

    expect(progressSeen.map(p => p.received)).toEqual([1, 5]);
    expect(staticRenders).toBe(staticRendersBefore);
  });
});
