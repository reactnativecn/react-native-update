import { describe, expect, mock, test } from 'bun:test';
import { executeEndpointFallback, pickRandomEndpoint } from '../endpoint';

const delay = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

describe('executeEndpointFallback', () => {
  test('uses a random configured endpoint first and stops after success', async () => {
    const tryEndpoint = mock(async (endpoint: string) => endpoint.toUpperCase());
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
    });

    expect(result.endpoint).toBe('c');
    expect(result.value).toBe('c-ok');
    expect(getRemoteEndpoints).toHaveBeenCalledTimes(1);
    expect(tryEndpoint.mock.calls.map(call => call[0])).toEqual([
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
    });

    expect(result.endpoint).toBe('c');
    expect(result.value).toBe('c-ok');
    expect(getRemoteEndpoints).toHaveBeenCalledTimes(2);
    expect(tryEndpoint.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'c']);
  });
});

describe('pickRandomEndpoint', () => {
  test('returns undefined for empty arrays', () => {
    expect(pickRandomEndpoint([])).toBeUndefined();
  });

  test('deterministically selects an endpoint using a custom random parameter', () => {
    const endpoints = ['a', 'b', 'c'];

    // Test random = 0 (picks first)
    const endpoints1 = [...endpoints];
    expect(pickRandomEndpoint(endpoints1, () => 0)).toBe('a');

    // Test random = 0.5 (picks middle)
    const endpoints2 = [...endpoints];
    expect(pickRandomEndpoint(endpoints2, () => 0.5)).toBe('b');

    // Test random = 0.99 (picks last)
    const endpoints3 = [...endpoints];
    expect(pickRandomEndpoint(endpoints3, () => 0.99)).toBe('c');
  });

  test('mutates the original array by removing the selected endpoint', () => {
    const endpoints = ['a', 'b', 'c'];
    const result = pickRandomEndpoint(endpoints, () => 0.5);

    expect(result).toBe('b');
    expect(endpoints).toEqual(['a', 'c']);
    expect(endpoints.length).toBe(2);
  });
});
