import { describe, expect, test } from 'bun:test';
import {
  MAX_DETAIL_LENGTH,
  resolveServerEventHash,
  resolveServerEventType,
  truncateDetail,
} from '../telemetry';

describe('resolveServerEventType', () => {
  test('maps lifecycle events to server aggregate types', () => {
    expect(resolveServerEventType('downloadSuccess')).toBe('download_success');
    expect(resolveServerEventType('markSuccess')).toBe('mark_success');
    expect(resolveServerEventType('rollback')).toBe('rollback');
    expect(resolveServerEventType('errorSwitchVersion')).toBe('patch_fail');
  });

  test('splits errorUpdate by underlying native code', () => {
    expect(resolveServerEventType('errorUpdate', 'DOWNLOAD_FAILED')).toBe(
      'download_fail',
    );
    expect(resolveServerEventType('errorUpdate')).toBe('download_fail');
    expect(resolveServerEventType('errorUpdate', 'PATCH_FAILED')).toBe(
      'patch_fail',
    );
  });

  test('returns undefined for local-only events', () => {
    expect(resolveServerEventType('checking')).toBeUndefined();
    expect(resolveServerEventType('downloading')).toBeUndefined();
    expect(resolveServerEventType('errorChecking')).toBeUndefined();
    expect(resolveServerEventType('errorMarkSuccess')).toBeUndefined();
    expect(resolveServerEventType('downloadingApk')).toBeUndefined();
  });
});

describe('resolveServerEventHash', () => {
  test('rollback uses the rolled back version', () => {
    expect(
      resolveServerEventHash({
        serverType: 'rollback',
        data: { rolledBackVersion: 'abc' },
        currentVersion: 'cur',
      }),
    ).toBe('abc');
  });

  test('mark_success falls back to the running version', () => {
    expect(
      resolveServerEventHash({
        serverType: 'mark_success',
        data: {},
        currentVersion: 'cur',
      }),
    ).toBe('cur');
  });

  test('download events require the target hash', () => {
    expect(
      resolveServerEventHash({
        serverType: 'download_fail',
        data: { newVersion: 'xyz' },
        currentVersion: 'cur',
      }),
    ).toBe('xyz');
    expect(
      resolveServerEventHash({
        serverType: 'download_fail',
        data: {},
        currentVersion: 'cur',
      }),
    ).toBe('');
  });
});

describe('truncateDetail', () => {
  test('caps detail under the server column limit', () => {
    expect(truncateDetail('x'.repeat(2000))?.length).toBe(MAX_DETAIL_LENGTH);
    expect(truncateDetail('short')).toBe('short');
    expect(truncateDetail('')).toBeUndefined();
    expect(truncateDetail(undefined)).toBeUndefined();
  });
});
