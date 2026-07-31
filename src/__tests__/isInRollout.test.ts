import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Use the preload setup file instead of inline mocks since bun resolves
// dynamic imports relative to the test runner's context and caching.
import './setup';

let mockUuid = '';
// Installed per test: setup.ts hands every module back to its real
// implementation after each test, so a file-scope mock would only survive the
// first one.
beforeEach(() => {
  mock.module('../core', () => {
    return {
      cInfo: {
        get uuid() {
          return mockUuid;
        },
      },
    };
  });
});

// Use a monotonic counter instead of Date.now() to avoid cache collisions
// when two dynamic imports happen within the same millisecond.
let importCounter = 0;

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
    // Golden values from the canonical murmur3_32 (cross-checked against
    // reference test vectors like "hello" -> 0x248bfa47).
    expect(murmurhash3_32_gc('test1') % 100).toBe(62);
    expect(murmurhash3_32_gc('test2') % 100).toBe(67);
    expect(murmurhash3_32_gc('test3') % 100).toBe(53);
    expect(
      murmurhash3_32_gc('123e4567-e89b-12d3-a456-426614174000') % 100
    ).toBe(86);
    expect(
      murmurhash3_32_gc('123e4567-e89b-12d3-a456-426614174001') % 100
    ).toBe(88);
  });

  it('should match canonical murmur3_32 reference vectors', () => {
    expect(murmurhash3_32_gc('')).toBe(0x00000000);
    expect(murmurhash3_32_gc('hello')).toBe(0x248bfa47);
    expect(murmurhash3_32_gc('test')).toBe(0xba6bd213);
    expect(murmurhash3_32_gc('Hello, world!')).toBe(0xc0363e43);
    expect(
      murmurhash3_32_gc('The quick brown fox jumps over the lazy dog')
    ).toBe(0x2e4ff723);
  });
});

describe('isInRollout', () => {
  it('should return true when the rollout is greater than the hash modulo', async () => {
    mockUuid = 'test1'; // hash % 100 === 62
    const { isInRollout } = await import(
      `../isInRollout?id=${++importCounter}`
    );
    expect(isInRollout(63)).toBe(true);
  });

  it('should return false when the rollout is equal to the hash modulo', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(
      `../isInRollout?id=${++importCounter}`
    );
    expect(isInRollout(62)).toBe(false);
  });

  it('should return false when the rollout is less than the hash modulo', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(
      `../isInRollout?id=${++importCounter}`
    );
    expect(isInRollout(61)).toBe(false);
  });

  it('should evaluate correctly for a different uuid', async () => {
    mockUuid = 'test3'; // hash % 100 === 53
    const { isInRollout } = await import(
      `../isInRollout?id=${++importCounter}`
    );
    expect(isInRollout(54)).toBe(true);
    expect(isInRollout(53)).toBe(false);
    expect(isInRollout(-1)).toBe(false);
  });

  it('should always return false for 0% rollout', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(
      `../isInRollout?id=${++importCounter}`
    );
    expect(isInRollout(0)).toBe(false);
  });

  it('should always return true for 100% rollout', async () => {
    mockUuid = 'test1';
    const { isInRollout } = await import(
      `../isInRollout?id=${++importCounter}`
    );
    expect(isInRollout(100)).toBe(true);
  });
});
