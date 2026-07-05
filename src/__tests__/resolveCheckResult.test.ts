import { describe, expect, test } from 'bun:test';
import { currentVersion, packageVersion } from '../core';
import { resolveCheckResult } from '../resolveCheckResult';
import type { CheckResult } from '../type';

const createRootResult = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  update: true,
  hash: 'full-hash',
  name: 'full-version',
  description: 'full description',
  metaInfo: 'full meta',
  diff: 'current-full.hdiff',
  pdiff: 'package-full.phdiff',
  full: 'full-hash',
  paths: ['cdn.example.com'],
  ...overrides,
});

describe('resolveCheckResult', () => {
  test('returns upToDate when rollout target is already current', () => {
    const result = resolveCheckResult(
      createRootResult({
        expVersion: {
          name: 'gray-current',
          hash: currentVersion,
          description: 'gray description',
          metaInfo: 'gray meta',
          config: {
            rollout: {
              [packageVersion]: 100,
            },
          },
        },
      }),
    );

    expect(result).toEqual({ upToDate: true });
  });

  test('does not inherit root diff artifacts for rollout target', () => {
    const result = resolveCheckResult(
      createRootResult({
        expVersion: {
          name: 'gray-next',
          hash: 'gray-hash',
          description: 'gray description',
          metaInfo: 'gray meta',
          config: {
            rollout: {
              [packageVersion]: 100,
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      update: true,
      hash: 'gray-hash',
      name: 'gray-next',
      description: 'gray description',
      metaInfo: 'gray meta',
      config: {
        rollout: {
          [packageVersion]: 100,
        },
      },
      paths: ['cdn.example.com'],
    });
  });

  test('falls back to root result when rollout target is not selected', () => {
    const result = resolveCheckResult(
      createRootResult({
        expVersion: {
          name: 'gray-next',
          hash: 'gray-hash',
          description: 'gray description',
          metaInfo: 'gray meta',
          config: {
            rollout: {
              [packageVersion]: 0,
            },
          },
        },
      }),
    );

    expect(result).toEqual(createRootResult());
  });

  test('returns upToDate when root target is already current', () => {
    const result = resolveCheckResult(
      createRootResult({ hash: currentVersion }),
    );

    expect(result).toEqual({ upToDate: true });
  });
});
