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

  test('maps over paths and prepends https:// with fileName', () => {
    expect(joinUrls(['example.com', 'test.org'], 'file.txt')).toEqual([
      'https://example.com/file.txt',
      'https://test.org/file.txt',
    ]);
  });
});
