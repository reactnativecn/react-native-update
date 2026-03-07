import { describe, expect, test, mock, beforeAll } from 'bun:test';

mock.module('../core', () => {
  return {
    cInfo: {
      uuid: 'fixed-test-uuid',
    },
  };
});

describe('isInRollout', () => {
  let isInRollout: (rollout: number) => boolean;

  beforeAll(async () => {
    // Dynamic import to ensure the mock is picked up
    // @ts-ignore
    const module = await import('../isInRollout?deterministic');
    isInRollout = module.isInRollout;
  });

  test('returns false when rollout is 0', () => {
    expect(isInRollout(0)).toBe(false);
  });

  test('returns false when rollout is less than or equal to the hash modulo (79)', () => {
    // 79 < 79 is false
    expect(isInRollout(79)).toBe(false);
  });

  test('returns true when rollout is strictly greater than the hash modulo (80)', () => {
    // 79 < 80 is true
    expect(isInRollout(80)).toBe(true);
  });

  test('returns true when rollout is 100', () => {
    expect(isInRollout(100)).toBe(true);
  });
});
