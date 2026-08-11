import { UpdateError } from './error';
import { dedupeEndpoints, orderEndpointCandidates } from './updateFlowCore';

export { dedupeEndpoints };

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
  tryEndpoint: (endpoint: string, signal?: AbortSignal) => Promise<T>;
  random?: () => number;
  now?: () => number;
  hedgeDelayMs?: number;
  onFirstFailure?: (failure: EndpointAttemptFailure) => void | Promise<void>;
}

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
};

export const DEFAULT_HEDGE_DELAY_MS = 250;

/**
 * Hedged race over the candidate endpoints: the first candidate starts
 * immediately, each following one is only started after `hedgeDelayMs` of
 * silence (or immediately when a previous attempt failed). The first
 * successful response wins and every other in-flight request is aborted, so
 * one slow endpoint never gates a fast one, and healthy rounds send a single
 * request instead of blasting every candidate at once.
 */
export function selectFastestSuccessfulEndpoint<T>(
  endpoints: string[],
  tryEndpoint: (endpoint: string, signal?: AbortSignal) => Promise<T>,
  now: () => number = Date.now,
  hedgeDelayMs: number = DEFAULT_HEDGE_DELAY_MS
): Promise<{
  success?: EndpointAttemptSuccess<T>;
  failures: EndpointAttemptFailure[];
}> {
  return new Promise((resolve) => {
    if (!endpoints.length) {
      resolve({ failures: [] });
      return;
    }

    const failures: EndpointAttemptFailure[] = [];
    const controllers: AbortController[] = [];
    let nextIndex = 0;
    let pending = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (success?: EndpointAttemptSuccess<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (hedgeTimer) {
        clearTimeout(hedgeTimer);
      }
      for (const controller of controllers) {
        controller.abort();
      }
      resolve({ success, failures });
    };

    const launchNext = () => {
      if (hedgeTimer) {
        clearTimeout(hedgeTimer);
        hedgeTimer = undefined;
      }
      if (settled || nextIndex >= endpoints.length) {
        return;
      }
      const endpoint = endpoints[nextIndex++];
      const controller =
        typeof AbortController === 'undefined'
          ? undefined
          : new AbortController();
      if (controller) {
        controllers.push(controller);
      }
      pending++;
      const start = now();
      tryEndpoint(endpoint, controller?.signal)
        .then((value) => {
          if (controller) {
            // Only the losing requests get aborted, not the winner's own
            // (already settled) one.
            const index = controllers.indexOf(controller);
            if (index >= 0) {
              controllers.splice(index, 1);
            }
          }
          finish({ endpoint, value, duration: now() - start });
        })
        .catch((error) => {
          pending--;
          if (settled) {
            // Losers cancelled after a win must not count as failures.
            return;
          }
          failures.push({ endpoint, error: normalizeError(error) });
          if (nextIndex < endpoints.length) {
            // A failure frees its slot: hedge the next candidate right away
            // instead of waiting out the stagger.
            launchNext();
          } else if (pending === 0) {
            finish(undefined);
          }
        });
      if (!settled && nextIndex < endpoints.length) {
        hedgeTimer = setTimeout(launchNext, hedgeDelayMs);
      }
    };

    launchNext();
  });
}

export async function executeEndpointFallback<T>({
  configuredEndpoints,
  getRemoteEndpoints,
  tryEndpoint,
  random = Math.random,
  now = Date.now,
  hedgeDelayMs = DEFAULT_HEDGE_DELAY_MS,
  onFirstFailure,
}: ExecuteEndpointFallbackOptions<T>): Promise<EndpointAttemptSuccess<T>> {
  const excludedEndpoints = new Set<string>();
  // The candidate ordering (random first pick, configured order as fallback)
  // is pure policy; this side only executes it.
  let candidates = orderEndpointCandidates(configuredEndpoints, random());

  if (!candidates.length) {
    throw new UpdateError('No endpoints configured', 'NO_ENDPOINTS');
  }

  const firstEndpoint = candidates[0];

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
        (endpoint) => !excludedEndpoints.has(endpoint)
      );

      if (!candidates.length) {
        throw lastError;
      }

      const { success, failures } = await selectFastestSuccessfulEndpoint(
        candidates,
        tryEndpoint,
        now,
        hedgeDelayMs
      );

      if (success) {
        return success;
      }

      for (const failure of failures) {
        excludedEndpoints.add(failure.endpoint);
        lastError = failure.error;
      }
    }
  }
}
