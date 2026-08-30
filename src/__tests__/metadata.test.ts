import { describe, expect, mock, test } from 'bun:test';

const importFreshMetadata = (cacheKey: string) =>
  import(`../metadata?${cacheKey}`);

const mockCore = (overrides: Record<string, any> = {}) => {
  mock.module('../core', () => ({
    buildTime: '1719999999',
    currentBundleSha256: 'c'.repeat(64),
    cInfo: { rnu: '10.53.1', rn: '0.85.2', os: 'ios 17.5', uuid: 'u-1' },
    currentVersion: 'running-hash',
    currentVersionInfo: {
      name: 'v2',
      description: 'fix',
      metaInfo: '{"a":1}',
    },
    getBundleHash: () => 'b'.repeat(64),
    isFirstTime: true,
    isRolledBack: false,
    packageVersion: '2.3.4',
    rolledBackVersion: '',
    ...overrides,
  }));
};

describe('getUpdateMetadata', () => {
  test('collects everything a crash report needs to pick the right source map', async () => {
    mockCore();
    const { getUpdateMetadata } = await importFreshMetadata('meta-basic');
    expect(getUpdateMetadata()).toEqual({
      sdkVersion: '10.53.1',
      packageVersion: '2.3.4',
      buildTime: '1719999999',
      currentVersion: 'running-hash',
      versionName: 'v2',
      versionDescription: 'fix',
      metaInfo: '{"a":1}',
      bundleHash: 'b'.repeat(64),
      bundleSha256: 'c'.repeat(64),
      isFirstTime: true,
      isRolledBack: false,
      rolledBackVersion: '',
      rescueSource: null,
      uuid: 'u-1',
      os: 'ios 17.5',
    });
  });

  test('reports the rescue path that activated the running version', async () => {
    mockCore({
      currentVersionInfo: { name: 'v3', crashRescue: true },
      isFirstTime: false,
    });
    const { getUpdateMetadata } = await importFreshMetadata('meta-rescue');
    expect(getUpdateMetadata().rescueSource).toBe('crashRescue');

    mockCore({ currentVersionInfo: { forceBootRescue: true } });
    const forced = await importFreshMetadata('meta-forceboot');
    expect(forced.getUpdateMetadata().rescueSource).toBe('forceBoot');
  });

  test('tolerates the embedded bundle and a rollback launch', async () => {
    mockCore({
      currentVersion: '',
      currentVersionInfo: {},
      isRolledBack: true,
      rolledBackVersion: 'bad-hash',
      getBundleHash: () => '',
    });
    const { getUpdateMetadata } = await importFreshMetadata('meta-rollback');
    const meta = getUpdateMetadata();
    expect(meta.currentVersion).toBe('');
    expect(meta.versionName).toBe('');
    expect(meta.isRolledBack).toBe(true);
    expect(meta.rolledBackVersion).toBe('bad-hash');
    expect(meta.bundleHash).toBe('');
  });
});

describe('attachUpdateMetadata', () => {
  test('feeds Sentry-style reporters tags plus a context', async () => {
    mockCore();
    const { attachToSentry } = await importFreshMetadata('meta-sentry');
    const tags: Record<string, string> = {};
    const contexts: Record<string, any> = {};
    const sentry = {
      setTag: (key: string, value: string) => {
        tags[key] = value;
      },
      setContext: (name: string, context: any) => {
        contexts[name] = context;
      },
    };
    const meta = attachToSentry(sentry);
    expect(tags['pushy.currentVersion']).toBe('running-hash');
    expect(tags['pushy.bundleSha256']).toBe('c'.repeat(64));
    expect(tags['pushy.isFirstTime']).toBe('true');
    expect(tags['pushy.rescueSource']).toBe('');
    expect(contexts.pushy).toEqual(meta);
  });

  test('feeds Crashlytics-style reporters custom keys and swallows failures', async () => {
    mockCore();
    const { attachToCrashlytics, attachUpdateMetadata } =
      await importFreshMetadata('meta-crashlytics');
    let received: Record<string, string> | undefined;
    attachToCrashlytics({
      setAttributes: async (attributes: Record<string, string>) => {
        received = attributes;
      },
    });
    expect(received?.['pushy.packageVersion']).toBe('2.3.4');

    // A reporter that throws or rejects never breaks the caller.
    expect(() =>
      attachUpdateMetadata({
        setTag: () => {
          throw new Error('reporter down');
        },
        setContext: async () => {
          throw new Error('reporter down');
        },
      })
    ).not.toThrow();
    expect(() => attachUpdateMetadata({})).not.toThrow();
  });
});
