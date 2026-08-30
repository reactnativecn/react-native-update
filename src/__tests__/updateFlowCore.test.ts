import { describe, expect, test } from 'bun:test';
import type { CheckResult } from '../type';
import {
  buildCheckFingerprint,
  buildCheckRequestBody,
  decideDownload,
  isMirrorRetryableCode,
  isValidCheckResult,
  orderEndpointCandidates,
} from '../updateFlowCore';

const cInfo = { rnu: '10.50.0', rn: '0.73.0', os: 'ios 17', uuid: 'uuid' };

const baseInput = {
  packageVersion: '1.0.0',
  currentVersion: 'current-hash',
  buildTime: '2023-01-01',
  cInfo,
};

describe('buildCheckRequestBody', () => {
  test('builds the base body', () => {
    expect(buildCheckRequestBody(baseInput)).toEqual({
      packageVersion: '1.0.0',
      hash: 'current-hash',
      buildTime: '2023-01-01',
      cInfo,
    });
  });

  test('includes diffV and bundleHash when known', () => {
    expect(
      buildCheckRequestBody({
        ...baseInput,
        supportedDiffVersion: 2,
        bundleHash: 'a'.repeat(64),
      })
    ).toEqual({
      packageVersion: '1.0.0',
      hash: 'current-hash',
      buildTime: '2023-01-01',
      cInfo,
      diffV: 2,
      bundleHash: 'a'.repeat(64),
    });
  });

  test('omits diffV and bundleHash while unknown', () => {
    const body = buildCheckRequestBody({
      ...baseInput,
      supportedDiffVersion: 0,
      bundleHash: '',
    });
    expect(body).not.toHaveProperty('diffV');
    expect(body).not.toHaveProperty('bundleHash');
  });

  test('extra can add fields but never overrides the SDK identity fields', () => {
    const body = buildCheckRequestBody({
      ...baseInput,
      supportedDiffVersion: 2,
      bundleHash: 'b'.repeat(64),
      extra: {
        toHash: 'debug-hash',
        hash: 'override-hash',
        packageVersion: '9.9.9',
        buildTime: 'forged',
        cInfo: { rnu: 'forged' },
        diffV: 99,
        bundleHash: 'forged',
      },
    });
    expect(body.toHash).toBe('debug-hash');
    // Nested copy for new servers, identity fields untouched inside it too.
    expect(body.extra).toEqual({
      toHash: 'debug-hash',
      hash: 'override-hash',
      packageVersion: '9.9.9',
      buildTime: 'forged',
      cInfo: { rnu: 'forged' },
      diffV: 99,
      bundleHash: 'forged',
    });
    expect(body.hash).toBe('current-hash');
    expect(body.packageVersion).toBe('1.0.0');
    expect(body.buildTime).toBe('2023-01-01');
    expect(body.cInfo).toEqual(cInfo);
    expect(body.diffV).toBe(2);
    expect(body.bundleHash).toBe('b'.repeat(64));
  });

  test('no extra means no nested extra key', () => {
    expect(buildCheckRequestBody(baseInput)).not.toHaveProperty('extra');
    expect(
      buildCheckRequestBody({ ...baseInput, extra: {} })
    ).not.toHaveProperty('extra');
  });

  test('extra cannot smuggle diffV / bundleHash when the SDK omits them', () => {
    const body = buildCheckRequestBody({
      ...baseInput,
      supportedDiffVersion: 0,
      bundleHash: '',
      extra: { diffV: 2, bundleHash: 'forged' },
    });
    expect(body).not.toHaveProperty('diffV');
    expect(body).not.toHaveProperty('bundleHash');
  });

  test('drops buildTime in dev, even when set via extra', () => {
    const body = buildCheckRequestBody({
      ...baseInput,
      isDev: true,
      extra: { buildTime: 'injected' },
    });
    expect(body).not.toHaveProperty('buildTime');
  });
});

describe('orderEndpointCandidates', () => {
  test('keeps configured order when the sample picks the first', () => {
    expect(orderEndpointCandidates(['a', 'b', 'c'], 0)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('moves the sampled pick to the front, rest in configured order', () => {
    expect(orderEndpointCandidates(['a', 'b', 'c'], 0.5)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(orderEndpointCandidates(['a', 'b', 'c'], 0.99)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('clamps an out-of-range sample to the last candidate', () => {
    expect(orderEndpointCandidates(['a', 'b', 'c'], 1)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('dedupes and drops empty entries before ordering', () => {
    expect(orderEndpointCandidates(['a', null, 'a', '', 'b'], 0)).toEqual([
      'a',
      'b',
    ]);
  });

  test('passes through empty and single-candidate lists', () => {
    expect(orderEndpointCandidates([], 0.5)).toEqual([]);
    expect(orderEndpointCandidates(['a'], 0.5)).toEqual(['a']);
  });

  test('clamps invalid or out-of-range samples before indexing', () => {
    expect(orderEndpointCandidates(['a', 'b'], Number.NaN)).toEqual(['a', 'b']);
    expect(
      orderEndpointCandidates(['a', 'b'], Number.POSITIVE_INFINITY)
    ).toEqual(['a', 'b']);
    expect(orderEndpointCandidates(['a', 'b'], -1)).toEqual(['a', 'b']);
    expect(orderEndpointCandidates(['a', 'b'], 2)).toEqual(['b', 'a']);
  });
});

describe('decideDownload', () => {
  const identity = {
    currentVersion: 'current-hash',
    rolledBackVersion: 'bad-hash',
  };

  const updateInfo = (overrides: Partial<CheckResult> = {}): CheckResult => ({
    update: true,
    hash: 'next-hash',
    diff: 'current-next.hdiff',
    pdiff: 'package-next.phdiff',
    full: 'next-hash.ppk',
    paths: ['cdn.example.com', 'https://mirror.example.com'],
    ...overrides,
  });

  test('declines when there is no update or no hash', () => {
    expect(decideDownload({ upToDate: true }, identity)).toEqual({
      action: 'none',
      reason: 'noUpdate',
    });
    expect(decideDownload({ update: true }, identity)).toEqual({
      action: 'none',
      reason: 'noUpdate',
    });
  });

  test('declines the currently running version', () => {
    expect(
      decideDownload(updateInfo({ hash: 'current-hash' }), identity)
    ).toEqual({ action: 'none', reason: 'alreadyCurrent' });
  });

  test('declines a rolled-back version', () => {
    expect(decideDownload(updateInfo({ hash: 'bad-hash' }), identity)).toEqual({
      action: 'none',
      reason: 'rolledBack',
    });
  });

  test('orders attempts diff → pdiff → full with joined candidate urls', () => {
    const decision = decideDownload(updateInfo(), identity);
    expect(decision).toEqual({
      action: 'download',
      hash: 'next-hash',
      devNoop: false,
      attempts: [
        {
          type: 'diff',
          urls: [
            'https://cdn.example.com/current-next.hdiff',
            'https://mirror.example.com/current-next.hdiff',
          ],
        },
        {
          type: 'pdiff',
          urls: [
            'https://cdn.example.com/package-next.phdiff',
            'https://mirror.example.com/package-next.phdiff',
          ],
        },
        {
          type: 'full',
          urls: [
            'https://cdn.example.com/next-hash.ppk',
            'https://mirror.example.com/next-hash.ppk',
          ],
        },
      ],
    });
  });

  test('skips artifacts the server did not offer', () => {
    const decision = decideDownload(updateInfo({ diff: undefined }), identity);
    if (decision.action !== 'download') {
      throw new Error('expected a download decision');
    }
    expect(decision.attempts.map((a) => a.type)).toEqual(['pdiff', 'full']);
  });

  test('declines a release update when no artifact URL can be built', () => {
    expect(decideDownload(updateInfo({ paths: [] }), identity)).toEqual({
      action: 'none',
      reason: 'noArtifact',
    });
  });

  test('dev only attempts full', () => {
    const decision = decideDownload(updateInfo(), identity, true);
    if (decision.action !== 'download') {
      throw new Error('expected a download decision');
    }
    expect(decision.attempts.map((a) => a.type)).toEqual(['full']);
    expect(decision.devNoop).toBe(false);
  });

  test('dev with no full artifact is a no-op success', () => {
    const decision = decideDownload(
      updateInfo({ full: undefined }),
      identity,
      true
    );
    if (decision.action !== 'download') {
      throw new Error('expected a download decision');
    }
    expect(decision.attempts).toEqual([]);
    expect(decision.devNoop).toBe(true);
  });
});

describe('buildCheckFingerprint', () => {
  const base = {
    appKey: 'app',
    endpoints: ['https://a.example.com'],
    queryUrls: ['https://q.example.com'],
    body: '{"hash":"x"}',
  };

  test('identical inputs produce identical fingerprints', () => {
    expect(buildCheckFingerprint(base)).toBe(
      buildCheckFingerprint({ ...base })
    );
  });

  test('any change in body, appKey or endpoints changes the fingerprint', () => {
    const fp = buildCheckFingerprint(base);
    expect(buildCheckFingerprint({ ...base, body: '{"hash":"y"}' })).not.toBe(
      fp
    );
    expect(buildCheckFingerprint({ ...base, appKey: 'other' })).not.toBe(fp);
    expect(
      buildCheckFingerprint({ ...base, endpoints: ['https://b.example.com'] })
    ).not.toBe(fp);
    expect(buildCheckFingerprint({ ...base, queryUrls: [] })).not.toBe(fp);
  });
});

describe('isMirrorRetryableCode', () => {
  test('transport failures try the next mirror', () => {
    expect(isMirrorRetryableCode('DOWNLOAD_FAILED')).toBe(true);
    expect(isMirrorRetryableCode(undefined)).toBe(true);
  });

  test('an unapplicable patch does not get re-downloaded elsewhere', () => {
    expect(isMirrorRetryableCode('PATCH_FAILED')).toBe(false);
  });
});

describe('isValidCheckResult', () => {
  test('accepts every verdict shape', () => {
    expect(isValidCheckResult({ upToDate: true })).toBe(true);
    expect(isValidCheckResult({ update: true, hash: 'h' })).toBe(true);
    expect(isValidCheckResult({ expired: true, downloadUrl: 'u' })).toBe(true);
    expect(isValidCheckResult({ paused: 'app' })).toBe(true);
  });

  test('rejects non-verdict payloads that still parse as JSON', () => {
    expect(isValidCheckResult({ error: 'internal' })).toBe(false);
    expect(isValidCheckResult({})).toBe(false);
    expect(isValidCheckResult([])).toBe(false);
    expect(isValidCheckResult(null)).toBe(false);
    expect(isValidCheckResult('upToDate')).toBe(false);
    expect(isValidCheckResult({ upToDate: 'yes' })).toBe(false);
    expect(isValidCheckResult({ update: 1 })).toBe(false);
  });
});
