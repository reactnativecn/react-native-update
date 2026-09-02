import { describe, expect, mock, test } from 'bun:test';
import {
  dedupeEndpoints,
  executeEndpointFallback,
  selectFastestSuccessfulEndpoint,
} from '../endpoint';

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('executeEndpointFallback', () => {
  test('uses a random configured endpoint first and stops after success', async () => {
    const tryEndpoint = mock(async (endpoint: string) =>
      endpoint.toUpperCase()
    );
    const getRemoteEndpoints = mock(async () => ['remote']);

    const result = await executeEndpointFallback({
      configuredEndpoints: ['a', 'b', 'c'],
      getRemoteEndpoints,
      tryEndpoint,
      random: () => 0.5,
    });

    expect(result.endpoint).toBe('b');
    expect(result.value).toBe('B');
    expect(tryEndpoint).toHaveBeenCalledTimes(1);
    expect(getRemoteEndpoints).not.toHaveBeenCalled();
  });

  test('removes the failed first endpoint, merges remote endpoints, and picks the fastest success', async () => {
    const tryEndpoint = mock(async (endpoint: string) => {
      if (endpoint === 'a') {
        throw new Error('a failed');
      }
      if (endpoint === 'b') {
        await delay(30);
        return 'b-ok';
      }
      if (endpoint === 'c') {
        await delay(10);
        return 'c-ok';
      }
      await delay(20);
      return 'd-ok';
    });
    const getRemoteEndpoints = mock(async () => ['c', 'd', 'a']);

    const result = await executeEndpointFallback({
      configuredEndpoints: ['a', 'b', 'c'],
      getRemoteEndpoints,
      tryEndpoint,
      random: () => 0,
      // Launch all candidates at once so the fastest one wins deterministically.
      hedgeDelayMs: 0,
    });

    expect(result.endpoint).toBe('c');
    expect(result.value).toBe('c-ok');
    expect(getRemoteEndpoints).toHaveBeenCalledTimes(1);
    expect(tryEndpoint.mock.calls.map((call) => call[0])).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  test('repeats prune and retry when the retry round also fails', async () => {
    const tryEndpoint = mock(async (endpoint: string) => {
      if (endpoint === 'c') {
        await delay(5);
        return 'c-ok';
      }
      throw new Error(`${endpoint} failed`);
    });
    let remoteCallCount = 0;
    const getRemoteEndpoints = mock(async () => {
      remoteCallCount++;
      if (remoteCallCount === 1) {
        return ['b'];
      }
      return ['b', 'c'];
    });

    const result = await executeEndpointFallback({
      configuredEndpoints: ['a', 'b'],
      getRemoteEndpoints,
      tryEndpoint,
      random: () => 0,
      hedgeDelayMs: 0,
    });

    expect(result.endpoint).toBe('c');
    expect(result.value).toBe('c-ok');
    expect(getRemoteEndpoints).toHaveBeenCalledTimes(2);
    expect(tryEndpoint.mock.calls.map((call) => call[0])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('selectFastestSuccessfulEndpoint', () => {
  test('returns a hedged fast success without waiting for a slow earlier candidate', async () => {
    const aborted: string[] = [];
    const start = Date.now();
    const result = await selectFastestSuccessfulEndpoint(
      ['slow', 'fast'],
      (endpoint, signal) =>
        new Promise<string>((resolve, reject) => {
          const ms = endpoint === 'slow' ? 2000 : 10;
          const timer = setTimeout(() => resolve(`${endpoint}-ok`), ms);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted.push(endpoint);
            reject(new Error('aborted'));
          });
        }),
      Date.now,
      20
    );
    const elapsed = Date.now() - start;

    expect(result.success?.endpoint).toBe('fast');
    expect(result.success?.value).toBe('fast-ok');
    expect(result.failures).toEqual([]);
    // The whole selection must complete in roughly hedgeDelay + fast-endpoint
    // time, not be gated on the 2s slow endpoint.
    expect(elapsed).toBeLessThan(500);
    // The losing request gets cancelled instead of running to completion.
    expect(aborted).toEqual(['slow']);
  });

  test('sends a single request when the first endpoint answers within the hedge delay', async () => {
    const calls: string[] = [];
    const result = await selectFastestSuccessfulEndpoint(
      ['a', 'b'],
      async (endpoint) => {
        calls.push(endpoint);
        await delay(5);
        return endpoint.toUpperCase();
      },
      Date.now,
      500
    );

    expect(result.success?.endpoint).toBe('a');
    expect(calls).toEqual(['a']);
  });

  test('hedges immediately when an attempt fails before the delay elapses', async () => {
    const start = Date.now();
    const result = await selectFastestSuccessfulEndpoint(
      ['bad', 'good'],
      async (endpoint) => {
        await delay(5);
        if (endpoint === 'bad') {
          throw new Error('bad failed');
        }
        return 'good-ok';
      },
      Date.now,
      2000
    );
    const elapsed = Date.now() - start;

    expect(result.success?.endpoint).toBe('good');
    expect(result.failures.map((failure) => failure.endpoint)).toEqual(['bad']);
    // The failure frees the slot: no waiting out the 2s hedge delay.
    expect(elapsed).toBeLessThan(500);
  });

  test('reports every failure when all candidates fail', async () => {
    const result = await selectFastestSuccessfulEndpoint(
      ['a', 'b'],
      async (endpoint) => {
        throw new Error(`${endpoint} failed`);
      },
      Date.now,
      0
    );

    expect(result.success).toBeUndefined();
    expect(result.failures.map((failure) => failure.endpoint).sort()).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('dedupeEndpoints', () => {
  test('removes duplicate endpoints', () => {
    const result = dedupeEndpoints(['a', 'b', 'a', 'c', 'b']);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('preserves the original order of the first occurrence', () => {
    const result = dedupeEndpoints(['c', 'b', 'a', 'c', 'd', 'b']);
    expect(result).toEqual(['c', 'b', 'a', 'd']);
  });

  test('filters out falsy values', () => {
    const result = dedupeEndpoints(['a', null, 'b', undefined, '', 'c']);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('returns an empty array when given an empty array', () => {
    const result = dedupeEndpoints([]);
    expect(result).toEqual([]);
  });
});

describe('executeEndpointFallback without endpoints', () => {
  test('rejects with NO_ENDPOINTS and a localized message', async () => {
    const err: any = await executeEndpointFallback({
      configuredEndpoints: [],
      tryEndpoint: async () => 'never',
    }).catch((e) => e);

    expect(err.code).toBe('NO_ENDPOINTS');
    // setup.ts mocks i18n.t to echo the key: the message went through i18n.
    expect(err.message).toBe('error_no_endpoints');
  });
});
