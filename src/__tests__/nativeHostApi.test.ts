import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  NativeUpdateRound,
  nativeUpdateResult,
} from '../../harmony/pushy/src/main/ets/NativeUpdateResult';
import type { NativeUpdateResult } from '../../harmony/pushy/src/main/ets/NativeUpdateResult';

// Evaluate the actual Harmony orchestrator in an isolated VM per test. Only
// platform imports, HTTP and download IO are substituted; entry points,
// scheduling, configuration gates, result mapping and reset checks are real.
const source = readFileSync(
  new URL(
    '../../harmony/pushy/src/main/ets/NativeCheckOrchestrator.ts',
    import.meta.url,
  ),
  'utf8',
)
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace(/^export /gm, '');
const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);

interface Decision {
  action: string;
  reason?: string;
  hash?: string;
  activate?: boolean;
}

function harness() {
  const values = new Map<string, string>();
  values.set('nativeConfig', JSON.stringify({ appKey: 'test-app' }));
  const timers: Array<() => void> = [];
  const state = {
    generation: 0,
    checks: 0,
    downloads: 0,
    commits: 0,
    downloadOK: true,
    commitOK: true,
    installed: false,
    reachable: true,
    decision: { action: 'none', reason: 'up_to_date' } as Decision,
    beforeResponse: async (): Promise<void> => {},
  };
  const context = {
    getKv: (key: string) => values.get(key),
    setKv: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeKv: async (key: string) => {
      values.delete(key);
    },
    getResetGeneration: () => state.generation,
    getCurrentVersion: () => '',
    getPackageVersion: () => '1.0',
    getBuildTime: () => '123',
    getBundleHash: async () => 'binary-hash',
    hasDownloadedVersion: () => state.installed,
    getBundleUrl: () => {
      throw new Error('host checks must not resolve the launch bundle again');
    },
    commitNativeCheckResult: async (generation: number) => {
      state.commits += 1;
      return generation === state.generation && state.commitOK;
    },
  };
  const runtime = runInNewContext(
    `${javascript}\nrunCheckRequest = mockCheck;\nperformAttempts = mockDownload;\n({ check: checkAndUpdateNative, schedule: scheduleNativeCheck });`,
    {
      NativeUpdateRound,
      nativeUpdateResult,
      logger: { info() {}, warn() {}, error() {} },
      deviceInfo: { osFullName: 'test-os' },
      setTimeout: (callback: () => void) => timers.push(callback),
      isSafePathComponent: (hash: string) => /^[a-zA-Z0-9_-]+$/.test(hash),
      getErrorMessage: (error: unknown) => String(error),
      NativePatchCore: {
        getSupportedDiffVersion: () => 2,
        buildCheckRequestBody: (input: string) => input,
        handleCheckResponse: (response: string) => response,
      },
      mockCheck: async () => {
        state.checks += 1;
        await state.beforeResponse();
        return state.reachable ? JSON.stringify(state.decision) : undefined;
      },
      mockDownload: async () => {
        state.downloads += 1;
        return state.downloadOK;
      },
    },
  ) as {
    check: (ctx: typeof context) => Promise<NativeUpdateResult>;
    schedule: (ctx: typeof context, rollback: string) => void;
  };
  return {
    values,
    state,
    timers,
    check: () => runtime.check(context),
    initialize: () => runtime.schedule(context, 'rolled-back-version'),
  };
}

describe('native host API orchestration', () => {
  test('requires real launch initialization, without resolving the bundle', async () => {
    const h = harness();
    expect((await h.check()).reason).toBe('not_initialized');
    expect(h.state.checks).toBe(0);
    h.initialize();
    expect((await h.check()).status).toBe('noUpdate');
  });

  test('missing, disabled and malformed config do not consume a host round', async () => {
    const h = harness();
    h.initialize();
    h.values.delete('nativeConfig');
    expect((await h.check()).reason).toBe('not_configured');
    h.values.set('nativeConfig', '{');
    expect((await h.check()).reason).toBe('invalid_config');
    h.values.set('nativeConfig', JSON.stringify({ disabled: true }));
    expect((await h.check()).reason).toBe('disabled');
    expect(h.state.checks).toBe(0);
    h.values.set('nativeConfig', JSON.stringify({ appKey: 'test-app' }));
    expect((await h.check()).status).toBe('noUpdate');
    expect(h.state.checks).toBe(1);
  });

  test('manual, concurrent and delayed calls share one download and commit', async () => {
    const h = harness();
    h.initialize();
    h.state.decision = { action: 'download', hash: 'v2', activate: true };
    const first = h.check();
    const second = h.check();
    for (const timer of h.timers) timer();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(nativeUpdateResult('downloaded', '', 'v2', true));
    expect(results[1]).toEqual(results[0]);
    results[0].hash = 'caller-mutated';
    expect((await h.check()).hash).toBe('v2');
    expect(h.state.checks).toBe(1);
    expect(h.state.downloads).toBe(1);
    expect(h.state.commits).toBe(1);
    expect(h.values.has('nativeCheckIncomplete')).toBe(false);
  });

  test('a download need not select a bundle for the next launch', async () => {
    const h = harness();
    h.initialize();
    h.state.decision = { action: 'download', hash: 'v2', activate: false };
    expect(await h.check()).toEqual(nativeUpdateResult('downloaded', '', 'v2'));
  });

  test('an installed version skips transfer but still reports activation', async () => {
    const h = harness();
    h.initialize();
    h.state.installed = true;
    h.state.decision = { action: 'download', hash: 'v2', activate: true };
    expect((await h.check()).activated).toBe(true);
    expect(h.state.downloads).toBe(0);
  });

  test('network and download failure are not reported as no update', async () => {
    const offline = harness();
    offline.initialize();
    offline.state.reachable = false;
    expect(await offline.check()).toEqual(nativeUpdateResult('failed', 'check_failed'));
    const h = harness();
    h.initialize();
    h.state.decision = { action: 'download', hash: 'v2' };
    h.state.downloadOK = false;
    expect(await h.check()).toEqual(nativeUpdateResult('failed', 'download_failed'));
    await h.check();
    expect(h.state.downloads).toBe(1);
  });

  test('reset during a round cancels its result', async () => {
    const h = harness();
    h.initialize();
    h.state.beforeResponse = async () => {
      h.state.generation += 1;
    };
    expect(await h.check()).toEqual(nativeUpdateResult('cancelled', 'reset'));
  });

  test('reset and configuration changes invalidate completed snapshots', async () => {
    const reset = harness();
    reset.initialize();
    await reset.check();
    reset.state.generation += 1;
    expect((await reset.check()).reason).toBe('reset');
    const h = harness();
    h.initialize();
    await h.check();
    h.values.set('nativeConfig', JSON.stringify({ appKey: 'other-app' }));
    expect((await h.check()).reason).toBe('config_changed');
    expect(h.state.checks).toBe(1);
  });
});
