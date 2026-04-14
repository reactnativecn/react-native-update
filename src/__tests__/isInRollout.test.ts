import { describe, expect, it, mock } from 'bun:test';

// Use the preload setup file instead of inline mocks since bun resolves
// dynamic imports relative to the test runner's context and caching.
import './setup';

let mockUuid = '';
mock.module('../core', () => {
  return {
    cInfo: {
      get uuid() { return mockUuid; }
    }
  };
});

import { murmurhash3_32_gc } from '../isInRollout';

describe('murmurhash3_32_gc', () => {
  it('should be deterministic (return the same output for the same input)', () => {
    const input1 = '123e4567-e89b-12d3-a456-426614174000';
    const input2 = 'test-string';

    expect(murmurhash3_32_gc(input1)).toBe(murmurhash3_32_gc(input1));
    expect(murmurhash3_32_gc(input2)).toBe(murmurhash3_32_gc(input2));
  });

  it('should return different outputs for different inputs', () => {
    const input1 = '123e4567-e89b-12d3-a456-426614174000';
    const input2 = '123e4567-e89b-12d3-a456-426614174001';

    expect(murmurhash3_32_gc(input1)).not.toBe(murmurhash3_32_gc(input2));
  });

  it('should handle empty string correctly', () => {
    expect(typeof murmurhash3_32_gc('')).toBe('number');
  });

  it('should return known outputs for known inputs', () => {
    expect(murmurhash3_32_gc('test1') % 100).toBe(24);
    expect(murmurhash3_32_gc('test2') % 100).toBe(69);
    expect(murmurhash3_32_gc('test3') % 100).toBe(0);
    expect(murmurhash3_32_gc('123e4567-e89b-12d3-a456-426614174000') % 100).toBe(36);
    expect(murmurhash3_32_gc('123e4567-e89b-12d3-a456-426614174001') % 100).toBe(94);
  });
});

describe('isInRollout', () => {
  it('should return true when the rollout is greater than the hash modulo', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(`../isInRollout?id=${Date.now()}`);
    expect(isInRollout(25)).toBe(true);
  });

  it('should return false when the rollout is equal to the hash modulo', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(`../isInRollout?id=${Date.now()}`);
    expect(isInRollout(24)).toBe(false);
  });

  it('should return false when the rollout is less than the hash modulo', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(`../isInRollout?id=${Date.now()}`);
    expect(isInRollout(23)).toBe(false);
  });

  it('should evaluate correctly for a different uuid', async () => {
    mockUuid = 'test3';
    const { isInRollout } = await import(`../isInRollout?id=${Date.now()}`);
    expect(isInRollout(1)).toBe(true);
    expect(isInRollout(0)).toBe(false);
    expect(isInRollout(-1)).toBe(false);
  });

  it('should always return false for 0% rollout', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(`../isInRollout?id=${Date.now()}`);
    expect(isInRollout(0)).toBe(false);
  });

  it('should always return true for 100% rollout', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(`../isInRollout?id=${Date.now()}`);
    expect(isInRollout(100)).toBe(true);
  });
});
