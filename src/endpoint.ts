export interface EndpointAttemptSuccess<T> {
  endpoint: string;
  value: T;
  duration: number;
}

export interface EndpointAttemptFailure {
  endpoint: string;
  error: Error;
}

export interface ExecuteEndpointFallbackOptions<T> {
  configuredEndpoints: string[];
  getRemoteEndpoints?: () => Promise<string[]>;
  tryEndpoint: (endpoint: string) => Promise<T>;
  random?: () => number;
  now?: () => number;
  onFirstFailure?: (failure: EndpointAttemptFailure) => void | Promise<void>;
}

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
};

export const dedupeEndpoints = (
  endpoints: Array<string | null | undefined>,
): string[] => {
  const result: string[] = [];
  const visited = new Set<string>();

  for (const endpoint of endpoints) {
    if (!endpoint || visited.has(endpoint)) {
      continue;
    }
    visited.add(endpoint);
    result.push(endpoint);
  }

  return result;
};

export const pickRandomEndpoint = (
  endpoints: string[],
  random = Math.random,
): string | undefined => {
  if (endpoints.length === 0) return undefined;
  const index = Math.floor(random() * endpoints.length);
  return endpoints.splice(index, 1)[0];
};

export async function selectFastestSuccessfulEndpoint<T>(
  endpoints: string[],
  tryEndpoint: (endpoint: string) => Promise<T>,
  now: () => number = Date.now,
): Promise<{
  successes: EndpointAttemptSuccess<T>[];
  failures: EndpointAttemptFailure[];
}> {
  const attempts = await Promise.all(
    endpoints.map(async endpoint => {
      const start = now();
      try {
        const value = await tryEndpoint(endpoint);
        return {
          ok: true as const,
          endpoint,
          value,
          duration: now() - start,
        };
      } catch (error) {
        return {
          ok: false as const,
          endpoint,
          error: normalizeError(error),
        };
      }
    }),
  );

  const successes: EndpointAttemptSuccess<T>[] = [];
  const failures: EndpointAttemptFailure[] = [];

  for (const attempt of attempts) {
    if (attempt.ok) {
      successes.push({
        endpoint: attempt.endpoint,
        value: attempt.value,
        duration: attempt.duration,
      });
      continue;
    }

    failures.push({
      endpoint: attempt.endpoint,
      error: attempt.error,
    });
  }

  successes.sort((left, right) => left.duration - right.duration);

  return {
    successes,
    failures,
  };
}

export async function executeEndpointFallback<T>({
  configuredEndpoints,
  getRemoteEndpoints,
  tryEndpoint,
  random = Math.random,
  now = Date.now,
  onFirstFailure,
}: ExecuteEndpointFallbackOptions<T>): Promise<EndpointAttemptSuccess<T>> {
  const excludedEndpoints = new Set<string>();
  let candidates = dedupeEndpoints(configuredEndpoints);

  if (!candidates.length) {
    throw new Error('No endpoints configured');
  }

  const firstEndpoint = pickRandomEndpoint(candidates, random);
  if (!firstEndpoint) {
    throw new Error('No endpoints configured');
  }

  try {
    return {
      endpoint: firstEndpoint,
      value: await tryEndpoint(firstEndpoint),
      duration: 0,
    };
  } catch (error) {
    const firstFailure = {
      endpoint: firstEndpoint,
      error: normalizeError(error),
    };
    excludedEndpoints.add(firstEndpoint);
    await onFirstFailure?.(firstFailure);
    let lastError = firstFailure.error;

    while (true) {
      const remoteEndpoints = getRemoteEndpoints
        ? await getRemoteEndpoints().catch(() => [])
        : [];
      candidates = dedupeEndpoints([...candidates, ...remoteEndpoints]).filter(
        endpoint => !excludedEndpoints.has(endpoint),
      );

      if (!candidates.length) {
        throw lastError;
      }

      const { successes, failures } = await selectFastestSuccessfulEndpoint(
        candidates,
        tryEndpoint,
        now,
      );

      if (successes.length) {
        return successes[0];
      }

      for (const failure of failures) {
        excludedEndpoints.add(failure.endpoint);
        lastError = failure.error;
      }
    }
  }
}
