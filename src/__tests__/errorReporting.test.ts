import { afterEach, describe, expect, test } from 'bun:test';
import {
  installGlobalErrorHandler,
  serializeException,
} from '../errorReporting';

const originalErrorUtils = (globalThis as any).ErrorUtils;

afterEach(() => {
  if (originalErrorUtils === undefined) {
    delete (globalThis as any).ErrorUtils;
  } else {
    (globalThis as any).ErrorUtils = originalErrorUtils;
  }
});

describe('JS error reporting helpers', () => {
  test('serializes Error-like values and keeps scalar bounded context', () => {
    const error = Object.assign(new Error('boom'), {
      name: 'TypeError',
      stack: 'TypeError: boom\n at index.android.bundle:12:34',
    });
    const serialized = serializeException(error, {
      fatal: true,
      componentStack: 'at OrderScreen',
      extra: {
        screen: 'order',
        retry: 2,
        offline: false,
        empty: null,
      },
    });
    expect(serialized).toEqual({
      name: 'TypeError',
      message: 'boom',
      stack: error.stack,
      fatal: true,
      componentStack: 'at OrderScreen',
      extra: { screen: 'order', retry: 2, offline: false, empty: null },
    });
  });

  test('normalizes thrown primitives and truncates oversized fields', () => {
    expect(serializeException('failed')).toEqual({
      name: 'Error',
      message: 'failed',
      stack: 'Error: failed',
      fatal: false,
    });
    const serialized = serializeException({
      name: 'x'.repeat(200),
      message: 'm'.repeat(3000),
      stack: 's'.repeat(40_000),
    });
    expect(serialized.name).toHaveLength(128);
    expect(serialized.message).toHaveLength(2048);
    expect(serialized.stack).toHaveLength(32 * 1024);
  });

  test('chains the existing global handler and does not overwrite a later one', () => {
    const calls: string[] = [];
    let current = (_error: unknown, fatal?: boolean) => {
      calls.push(`previous:${fatal}`);
    };
    (globalThis as any).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (handler: typeof current) => {
        current = handler;
      },
    };
    const uninstall = installGlobalErrorHandler((_error, fatal) => {
      calls.push(`capture:${fatal}`);
    });
    current(new Error('boom'), true);
    expect(calls).toEqual(['capture:true', 'previous:true']);

    const later = () => {};
    current = later;
    uninstall();
    expect(current).toBe(later);
  });
});
