import { afterEach, describe, expect, mock, test } from 'bun:test';

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

import {
  computeProgress,
  enhancedFetch,
  fetchWithTimeout,
  isProtocolDowngrade,
  joinUrls,
  promiseAny,
  testUrls,
} from '../utils';

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

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
        [
          'http://127.0.0.1:31337/artifacts/ios/',
          'https://cdn.example.com/base',
        ],
        'file.txt'
      )
    ).toEqual([
      'http://127.0.0.1:31337/artifacts/ios/file.txt',
      'https://cdn.example.com/base/file.txt',
    ]);
  });

  test('handles empty string paths', () => {
    expect(joinUrls([''], 'file.txt')).toEqual(['https:///file.txt']);
  });

  test('trims multiple trailing slashes', () => {
    expect(
      joinUrls(['example.com///', 'http://example.com///'], 'file.txt')
    ).toEqual(['https://example.com/file.txt', 'http://example.com/file.txt']);
  });

  test('preserves custom protocols', () => {
    expect(
      joinUrls(['ftp://example.com', 'myapp://some/path'], 'file.txt')
    ).toEqual(['ftp://example.com/file.txt', 'myapp://some/path/file.txt']);
  });

  test('prepends https:// to IP addresses with ports', () => {
    expect(
      joinUrls(['192.168.1.1:8080', '10.0.0.1:3000/api'], 'file.txt')
    ).toEqual([
      'https://192.168.1.1:8080/file.txt',
      'https://10.0.0.1:3000/api/file.txt',
    ]);
  });
});

describe('computeProgress', () => {
  test('returns 0 when total is 0', () => {
    expect(computeProgress(0, 0)).toBe(0);
  });

  test('returns 0 when received is 0', () => {
    expect(computeProgress(0, 1000)).toBe(0);
  });

  test('returns 100 when received equals total', () => {
    expect(computeProgress(1000, 1000)).toBe(100);
  });

  test('caps progress at 100 when received exceeds total', () => {
    expect(computeProgress(1200, 1000)).toBe(100);
  });

  test('floors progress at 0 when received is negative', () => {
    expect(computeProgress(-100, 1000)).toBe(0);
  });

  test('returns 50 for half progress', () => {
    expect(computeProgress(500, 1000)).toBe(50);
  });

  test('floors fractional percentages', () => {
    expect(computeProgress(1, 3)).toBe(33);
    expect(computeProgress(2, 3)).toBe(66);
  });

  test('handles large numbers', () => {
    expect(computeProgress(50_000_000, 100_000_000)).toBe(50);
  });
});

describe('fetchWithTimeout', () => {
  test('aborts the underlying request on timeout (JS-11 regression)', async () => {
    let capturedSignal: AbortSignal | undefined;
    (globalThis as any).fetch = mock((_url: string, params: any) => {
      capturedSignal = params?.signal;
      // Never settles on its own; only the abort signal can end it.
      return new Promise((_, reject) => {
        params?.signal?.addEventListener('abort', () =>
          reject(new Error('Aborted'))
        );
      });
    });

    await expect(
      fetchWithTimeout('https://example.com/slow', {}, 20)
    ).rejects.toThrow('error_ping_timeout');
    expect(capturedSignal?.aborted).toBe(true);
  });

  test('resolves normally before the timeout', async () => {
    const response = { ok: true } as Response;
    (globalThis as any).fetch = mock(async () => response);

    expect(await fetchWithTimeout('https://example.com/fast', {}, 1000)).toBe(
      response
    );
  });

  test('falls back to a timer race when AbortController is unavailable (RN < 0.60)', async () => {
    const originalAbortController = (globalThis as any).AbortController;
    delete (globalThis as any).AbortController;
    const fetchMock = mock(() => new Promise<Response>(() => {}));
    (globalThis as any).fetch = fetchMock;

    try {
      await expect(
        fetchWithTimeout('https://example.com/slow', {}, 20)
      ).rejects.toThrow('error_ping_timeout');
      // Legacy path must not pass a signal the runtime does not understand.
      expect((fetchMock.mock.calls[0] as any[])[1]?.signal).toBeUndefined();
    } finally {
      (globalThis as any).AbortController = originalAbortController;
    }
  });

  test('still resolves successful responses on the fallback path', async () => {
    const originalAbortController = (globalThis as any).AbortController;
    delete (globalThis as any).AbortController;
    const response = { ok: true } as Response;
    (globalThis as any).fetch = mock(async () => response);

    try {
      expect(await fetchWithTimeout('https://example.com/fast', {}, 1000)).toBe(
        response
      );
    } finally {
      (globalThis as any).AbortController = originalAbortController;
    }
  });
});

describe('enhancedFetch never downgrades https to http', () => {
  test('a failed https GET is not replayed over http', async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = mock(async (url: string) => {
      calls.push(url);
      throw new Error('tls blocked');
    });

    await expect(
      enhancedFetch('https://example.com/dl/https-bundle.ppk', {})
    ).rejects.toThrow('tls blocked');
    // Exactly one request, and it stayed on https.
    expect(calls).toEqual(['https://example.com/dl/https-bundle.ppk']);
  });

  test('a failed https HEAD is not replayed over http', async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = mock(async (url: string) => {
      calls.push(url);
      throw new Error('tls blocked');
    });

    await expect(
      enhancedFetch('https://example.com/dl/bundle.ppk', { method: 'HEAD' })
    ).rejects.toThrow('tls blocked');
    expect(calls).toEqual(['https://example.com/dl/bundle.ppk']);
  });

  test('does not replay POST requests over http (JS-11 regression)', async () => {
    const fetchMock = mock(async () => {
      throw new Error('tls blocked');
    });
    (globalThis as any).fetch = fetchMock;

    await expect(
      enhancedFetch('https://example.com/api', { method: 'POST', body: '{}' })
    ).rejects.toThrow('tls blocked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('plain http urls are passed through unchanged', async () => {
    const fetchMock = mock(async () => {
      throw new Error('offline');
    });
    (globalThis as any).fetch = fetchMock;

    await expect(enhancedFetch('http://example.com/api', {})).rejects.toThrow(
      'offline'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects a response whose final url was redirected to http', async () => {
    (globalThis as any).fetch = mock(async () => ({
      ok: true,
      status: 200,
      url: 'http://mirror.example.com/bundle.ppk',
    }));

    await expect(
      enhancedFetch('https://example.com/bundle.ppk', {})
    ).rejects.toThrow('error_insecure_redirect');
  });

  test('keeps a response that stayed on https after redirects', async () => {
    const response = {
      ok: true,
      status: 200,
      url: 'https://mirror.example.com/bundle.ppk',
    } as Response;
    (globalThis as any).fetch = mock(async () => response);

    expect(await enhancedFetch('https://example.com/bundle.ppk', {})).toBe(
      response
    );
  });

  test('isProtocolDowngrade only flags https -> http', () => {
    expect(isProtocolDowngrade('https://a', 'http://b')).toBe(true);
    expect(isProtocolDowngrade('HTTPS://a', 'HTTP://b')).toBe(true);
    expect(isProtocolDowngrade('https://a', 'https://b')).toBe(false);
    expect(isProtocolDowngrade('http://a', 'https://b')).toBe(false);
    expect(isProtocolDowngrade('http://a', 'http://b')).toBe(false);
    expect(isProtocolDowngrade('https://a', undefined)).toBe(false);
    expect(isProtocolDowngrade('https://a', '')).toBe(false);
  });
});

describe('testUrls', () => {
  test('a HEAD probe redirected to http never becomes the download url', async () => {
    (globalThis as any).fetch = mock(async (url: string) => {
      if (url === 'https://bad.example.com/bundle.ppk') {
        return {
          status: 200,
          statusText: 'OK',
          url: 'http://bad.example.com/bundle.ppk',
        };
      }
      return { status: 200, statusText: 'OK', url };
    });

    expect(
      await testUrls([
        'https://bad.example.com/bundle.ppk',
        'https://good.example.com/bundle.ppk',
      ])
    ).toBe('https://good.example.com/bundle.ppk');
  });

  test('when every probe downgrades, the configured https url is kept', async () => {
    (globalThis as any).fetch = mock(async (url: string) => ({
      status: 200,
      statusText: 'OK',
      url: url.replace(/^https:/, 'http:'),
    }));

    // Falls back to the first configured url, still https — the real
    // download then fails closed instead of silently going plaintext.
    expect(await testUrls(['https://a.example.com/x'])).toBe(
      'https://a.example.com/x'
    );
  });
});

describe('promiseAny', () => {
  test('rejects immediately on an empty array instead of hanging (JS-18)', async () => {
    await expect(promiseAny([])).rejects.toThrow('error_all_promises_rejected');
  });

  test('resolves with the first fulfilled promise', async () => {
    expect(
      await promiseAny([
        Promise.reject(new Error('a')),
        Promise.resolve('winner'),
      ])
    ).toBe('winner');
  });
});
