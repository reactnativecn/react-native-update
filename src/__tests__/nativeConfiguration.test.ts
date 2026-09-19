import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { NativeUpdateConfig } from '../../harmony/pushy/src/main/ets/NativeUpdateConfig';
import { normalizeNativeUpdateConfig } from '../../harmony/pushy/src/main/ets/NativeUpdateConfig';

function runtimeSource(relativePath: string): string {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export\s*\{[^}]*\}(?:\s*from\s*[^;]*)?;\r?\n/gm, '')
    .replace(/^export /gm, '');
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
}

const storeSource = runtimeSource('../../harmony/pushy/src/main/ets/UpdateContext.ts');
const clientSource = runtimeSource('../client.ts');

interface ConfigStore {
  setNativeConfig: (config: string) => Promise<void>;
  getResetGeneration: () => number;
  commitNativeCheckResult: (
    generation: number,
    hash: string,
    info: string,
    activate: boolean,
    cache: string
  ) => Promise<boolean>;
}

function storeHarness() {
  const values = new Map<string, string>();
  let flushes = 0;
  let shouldFail = false;
  const clearedSignals: string[] = [];
  const preferences = {
    getSync: (key: string, fallback: string) => values.get(key) ?? fallback,
    putSync: (key: string, value: string) => values.set(key, value),
    deleteSync: (key: string) => values.delete(key),
    flush: async () => {
      flushes++;
      if (shouldFail) throw new Error('storage unavailable');
    },
  };
  const store = runInNewContext(
    `${storeSource}\nconst store = Object.create(UpdateContext.prototype); store.preferences = preferences; store.flushBatchDepth = 0; store;`,
    {
      preferences,
      KEY_CONFIG: 'nativeConfig',
      KEY_RESP_CACHE: 'nativeCheckResp',
      markJsCheckCompleted: (config: string) => clearedSignals.push(config),
      logger: { error() {} },
      getErrorMessage: (error: unknown) => String(error),
    }
  ) as ConfigStore;
  return {
    store, values, clearedSignals,
    fail: (value: boolean) => { shouldFail = value; },
    flushes: () => flushes,
  };
}

function clientHarness(native: boolean) {
  const writes: string[] = [];
  const client = runInNewContext(
    `${clientSource}\nnew Pushy({appKey: 'test-app', nativeConfigSource: source, disableTelemetry: true});`,
    {
      source: native ? 'native' : 'javascript',
      __DEV__: false,
      assertWeb() {},
      noop() {},
      log() {},
      setDebugLogging() {},
      cInfo: { rnu: 'test-sdk', rn: 'test-rn' },
      packageVersion: '1.0',
      isRolledBack: false,
      Platform: { OS: 'android' },
      i18n: { setLocale() {} },
      dedupeEndpoints: (urls: string[]) => [...new Set(urls)],
      PushyModule: {
        syncNativeConfig: async (config: string) => { writes.push(config); },
      },
    }
  ) as { setOptions: (options: Record<string, unknown>) => void };
  return { client, writes };
}

describe('native configuration normalization', () => {
  test('appKey alone supplies Pushy endpoints without automatically activating', () => {
    const config = JSON.parse(normalizeNativeUpdateConfig({ appKey: 'test-app' }));
    expect(config.endpoints).toEqual([
      'https://update.react-native.cn/api', 'https://update.reactnative.cn/api',
    ]);
    expect(config.queryUrls).toHaveLength(2);
    expect(config.afterDownload).toBe('none');
    expect(config.disabled).toBe(false);
    expect(config.packageVersion).toBeUndefined();
  });

  test('custom endpoints do not inherit public discovery, and are deduplicated', () => {
    const options: NativeUpdateConfig = {
      appKey: 'test-app',
      endpoints: ['https://updates.example/api/', 'https://updates.example/api'],
      afterDownload: 'setNeedUpdate',
    };
    const original = JSON.stringify(options);
    const config = JSON.parse(normalizeNativeUpdateConfig(options));
    expect(config.endpoints).toEqual(['https://updates.example/api']);
    expect(config.queryUrls).toEqual([]);
    expect(config.afterDownload).toBe('setNeedUpdate');
    expect(JSON.stringify(options)).toBe(original);
  });

  test('allows explicit discovery URLs and version identity overrides', () => {
    const config = JSON.parse(normalizeNativeUpdateConfig({
      appKey: 'test-app', endpoints: ['http://localhost:8080/api'],
      queryUrls: ['https://updates.example/endpoints.json?v=1'],
      packageVersion: '2.0', rn: '0.77.3', rnu: 'test-sdk', disabled: true,
    }));
    expect(config.packageVersion).toBe('2.0');
    expect(config.disabled).toBe(true);
    expect(config.queryUrls[0]).toContain('?v=1');
  });

  for (const [name, options] of [
    ['missing key', {}], ['blank key', { appKey: '   ' }],
    ['wrong key type', { appKey: 12 }],
    ['empty endpoints', { appKey: 'a', endpoints: [] }],
    ['null endpoints', { appKey: 'a', endpoints: null }],
    ['non-array endpoints', { appKey: 'a', endpoints: 'https://example.com' }],
    ['unsafe scheme', { appKey: 'a', endpoints: ['file:///tmp/update'] }],
    ['credentials', { appKey: 'a', endpoints: ['https://user:pass@example.com'] }],
    ['relative URL', { appKey: 'a', endpoints: ['/api'] }],
    ['base query', { appKey: 'a', endpoints: ['https://example.com/api?x=1'] }],
    ['wrong discovery type', { appKey: 'a', queryUrls: [42] }],
    ['wrong activation', { appKey: 'a', afterDownload: 'immediate' }],
    ['wrong disabled type', { appKey: 'a', disabled: 'false' }],
    ['blank package version', { appKey: 'a', packageVersion: '' }],
    ['unknown option', { appKey: 'a', endponts: ['https://example.com'] }],
  ] as const) {
    test(`rejects ${name} before storage is touched`, () => {
      expect(() => normalizeNativeUpdateConfig(options as unknown as NativeUpdateConfig)).toThrow();
    });
  }
});

describe('actual native configuration store', () => {
  test('configuration invalidates cache and old in-flight commits, even across A-B-A', async () => {
    const h = storeHarness();
    await h.store.setNativeConfig('A');
    const oldGeneration = h.store.getResetGeneration();
    h.values.set('nativeCheckResp', 'stale');
    await h.store.setNativeConfig('B');
    expect(h.values.has('nativeCheckResp')).toBe(false);
    await h.store.setNativeConfig('A');
    expect(h.store.getResetGeneration()).toBe(oldGeneration + 2);
    expect(await h.store.commitNativeCheckResult(oldGeneration, 'old', '{}', true, 'stale')).toBe(false);
    expect(h.values.has('hash_old')).toBe(false);
    expect(h.clearedSignals).toEqual(['', '', '']);
  });

  test('identical configuration is idempotent but still confirms persistence', async () => {
    const h = storeHarness();
    await h.store.setNativeConfig('A');
    const generation = h.store.getResetGeneration();
    await h.store.setNativeConfig('A');
    expect(h.store.getResetGeneration()).toBe(generation);
    expect(h.flushes()).toBe(2);
  });

  test('storage errors reject and an equal-value retry can recover', async () => {
    const h = storeHarness();
    h.fail(true);
    await expect(h.store.setNativeConfig('A')).rejects.toThrow('storage unavailable');
    h.fail(false);
    await h.store.setNativeConfig('A');
    expect(h.flushes()).toBe(2);
  });
});

describe('JS native configuration ownership', () => {
  test('native ownership suppresses constructor and setOptions writes', () => {
    const h = clientHarness(true);
    expect(h.writes).toEqual([]);
    h.client.setOptions({ updateStrategy: 'silentAndLater' });
    expect(h.writes).toEqual([]);
  });

  test('JS ownership retains existing synchronization, with explicit handover', () => {
    const js = clientHarness(false);
    expect(js.writes).toHaveLength(1);
    const native = clientHarness(true);
    native.client.setOptions({ nativeConfigSource: 'javascript' });
    expect(native.writes).toHaveLength(1);
  });
});
