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

import { joinUrls } from '../utils';

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

  test('handles empty string paths', () => {
    expect(joinUrls([''], 'file.txt')).toEqual(['https:///file.txt']);
  });

  test('trims multiple trailing slashes', () => {
    expect(joinUrls(['example.com///', 'http://example.com///'], 'file.txt')).toEqual([
      'https://example.com/file.txt',
      'http://example.com/file.txt',
    ]);
  });

  test('preserves custom protocols', () => {
    expect(joinUrls(['ftp://example.com', 'myapp://some/path'], 'file.txt')).toEqual([
      'ftp://example.com/file.txt',
      'myapp://some/path/file.txt',
    ]);
  });

  test('prepends https:// to IP addresses with ports', () => {
    expect(joinUrls(['192.168.1.1:8080', '10.0.0.1:3000/api'], 'file.txt')).toEqual([
      'https://192.168.1.1:8080/file.txt',
      'https://10.0.0.1:3000/api/file.txt',
    ]);
  });
});
