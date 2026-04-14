import { describe, expect, test, mock } from 'bun:test';

mock.module('react-native', () => {
  return {
    Platform: {
      OS: 'ios',
    },
  };
});

mock.module('../i18n', () => {
  return {
    default: {
      t: (key: string) => key,
    },
  };
});

import { joinUrls, promiseAny } from '../utils';

describe('joinUrls', () => {
  test('returns undefined when fileName is not provided', () => {
    expect(joinUrls(['example.com'])).toBeUndefined();
  });

  test('returns an empty array when paths is empty', () => {
    expect(joinUrls([], 'file.txt')).toEqual([]);
  });

  test('prepends https:// for host-only paths', () => {
    expect(joinUrls(['example.com', 'test.org'], 'file.txt')).toEqual([
      'https://example.com/file.txt',
      'https://test.org/file.txt',
    ]);
  });

  test('preserves absolute urls and trims trailing slashes', () => {
    expect(
      joinUrls(
        ['http://127.0.0.1:31337/artifacts/ios/', 'https://cdn.example.com/base'],
        'file.txt',
      ),
    ).toEqual([
      'http://127.0.0.1:31337/artifacts/ios/file.txt',
      'https://cdn.example.com/base/file.txt',
    ]);
  });
});

describe('promiseAny', () => {
  test('resolves with the value of the first resolved promise', async () => {
    const p1 = new Promise((resolve) => setTimeout(resolve, 50, 'p1'));
    const p2 = new Promise((resolve) => setTimeout(resolve, 10, 'p2'));
    const p3 = new Promise((resolve) => setTimeout(resolve, 30, 'p3'));

    const result = await promiseAny([p1, p2, p3]);
    expect(result).toBe('p2');
  });

  test('resolves with the value of the first resolved promise even if others reject', async () => {
    const p1 = new Promise((_, reject) => setTimeout(reject, 10, new Error('error1')));
    const p2 = new Promise((resolve) => setTimeout(resolve, 50, 'p2'));
    const p3 = new Promise((_, reject) => setTimeout(reject, 20, new Error('error3')));

    const result = await promiseAny([p1, p2, p3]);
    expect(result).toBe('p2');
  });

  test('rejects with error_all_promises_rejected when all promises reject', async () => {
    const p1 = Promise.reject(new Error('error1'));
    const p2 = new Promise((_, reject) => setTimeout(reject, 10, new Error('error2')));

    await expect(promiseAny([p1, p2])).rejects.toThrow('error_all_promises_rejected');
  });
});
