import { Platform } from 'react-native';
import i18n from './i18n';

// log/info are developer diagnostics (they include full check request bodies
// and responses); release builds only print them when the client's `debug`
// option is on. warn/error always print.
let debugLogging = false;
export const setDebugLogging = (enabled: boolean) => {
  debugLogging = !!enabled;
};
const isVerbose = () =>
  // Metro always defines __DEV__; guard anyway so a bundler that does not
  // cannot break the whole module at import time.
  (typeof __DEV__ === 'boolean' && __DEV__) || debugLogging;

export function log(...args: any[]) {
  if (isVerbose()) {
    console.log(i18n.t('dev_log_prefix'), ...args);
  }
}

export function info(...args: any[]) {
  if (isVerbose()) {
    console.info(i18n.t('dev_log_prefix'), ...args);
  }
}

export function warn(...args: any[]) {
  console.warn(i18n.t('dev_log_prefix'), ...args);
}

export function error(...args: any[]) {
  console.error(i18n.t('dev_log_prefix'), ...args);
}

export const isWeb = Platform.OS === 'web';
export const DEFAULT_FETCH_TIMEOUT_MS = 5000;

export function promiseAny<T>(promises: Promise<T>[]) {
  return new Promise<T>((resolve, reject) => {
    if (!promises.length) {
      reject(Error(i18n.t('error_all_promises_rejected')));
      return;
    }
    let count = 0;

    promises.forEach((promise) => {
      Promise.resolve(promise)
        .then(resolve)
        .catch(() => {
          count++;
          if (count === promises.length) {
            reject(Error(i18n.t('error_all_promises_rejected')));
          }
        });
    });
  });
}

export const noop = () => {};
const emptyModuleTarget: Record<string, typeof noop> = {};
export const emptyModule = new Proxy(emptyModuleTarget, {
  get(_target, _prop) {
    return noop;
  },
});

const ping = isWeb
  ? Promise.resolve
  : async (url: string) => {
      try {
        const {
          status,
          statusText,
          url: finalUrl,
        } = await fetchWithTimeout(
          url,
          {
            method: 'HEAD',
          },
          DEFAULT_FETCH_TIMEOUT_MS
        );
        if (status === 200) {
          if (isProtocolDowngrade(url, finalUrl)) {
            // The probe was redirected from https to plaintext http. Never
            // let a downgraded final URL win the race: the winner is what
            // the real artifact download uses.
            log('ping rejected: https redirected to http', url, finalUrl);
            throw Error(i18n.t('error_ping_failed'));
          }
          return finalUrl;
        }
        log('ping failed', url, status, statusText);
        throw Error(i18n.t('error_ping_failed'));
      } catch (e) {
        log('ping error', url, e);
        throw e;
      }
    };

export { joinUrls } from './updateFlowCore';

export const testUrls = async (urls?: string[]): Promise<string | null> => {
  if (!urls?.length) {
    return null;
  }

  try {
    const ret = await promiseAny(urls.map(ping));
    if (ret) {
      log('ping success, use url:', ret);
      return ret as string;
    }
  } catch {}
  log('all ping failed, use first url:', urls[0]);
  return urls[0];
};

export const assertWeb = () => {
  if (isWeb) {
    warn(i18n.t('dev_web_not_supported'));
    return false;
  }
  return true;
};

export const computeProgress = (received: number, total: number): number =>
  total > 0
    ? Math.min(100, Math.max(0, Math.floor((received / total) * 100)))
    : 0;

export const fetchWithTimeout = (
  url: string,
  params: Parameters<typeof fetch>[1],
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> => {
  // AbortController landed in the RN fetch polyfill around 0.60; we support
  // older peers, so fall back to a plain timer race when it is unavailable
  // (the losing fetch keeps running there — old runtimes can't do better).
  if (typeof AbortController === 'undefined') {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      enhancedFetch(url, params),
      new Promise<Response>((_, reject) => {
        timeoutId = setTimeout(() => {
          log('fetch timeout', url);
          reject(Error(i18n.t('error_ping_timeout')));
        }, timeoutMs);
      }),
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  // Abort the underlying request on timeout instead of racing a timer: with
  // Promise.race the losing fetch kept running (and kept the connection busy)
  // long after the caller had already moved on.
  const controller = new AbortController();
  // The timeout controller replaces params.signal on the fetch call, so a
  // caller-provided signal (e.g. the hedged endpoint race cancelling losers)
  // must be chained onto it manually.
  const externalSignal = (params as any)?.signal as AbortSignal | undefined;
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort);
  }
  const timeoutId = setTimeout(() => {
    log('fetch timeout', url);
    controller.abort();
  }, timeoutMs);

  return enhancedFetch(url, { ...params, signal: controller.signal as any })
    .catch((e: any) => {
      if (externalSignal?.aborted) {
        // Cancelled by the caller, not timed out; keep the abort semantics.
        throw e;
      }
      if (controller.signal.aborted) {
        throw Error(i18n.t('error_ping_timeout'));
      }
      throw e;
    })
    .finally(() => {
      clearTimeout(timeoutId);
      // A long-lived caller signal (one per endpoint race) would otherwise
      // keep every finished request's listener — and its controller — alive.
      externalSignal?.removeEventListener('abort', onExternalAbort);
    });
};

/**
 * Query parameters of a URL as a plain object, without a URL polyfill: the
 * only consumer is the test-channel deep link (`?type=...&data=...`). Handles
 * a missing `?`, a `#fragment`, `+` as space and percent-encoding; a value
 * that fails to decode is kept verbatim rather than throwing. Later
 * duplicates win.
 */
export const parseQueryParams = (url: string): Record<string, string> => {
  const params: Record<string, string> = {};
  const hashStart = url.indexOf('#');
  const withoutFragment = hashStart < 0 ? url : url.slice(0, hashStart);
  const queryStart = withoutFragment.indexOf('?');
  if (queryStart < 0) {
    return params;
  }
  const query = withoutFragment.slice(queryStart + 1);
  const decode = (value: string) => {
    const spaced = value.replace(/\+/g, ' ');
    try {
      return decodeURIComponent(spaced);
    } catch {
      return spaced;
    }
  };
  for (const pair of query.split('&')) {
    if (!pair) {
      continue;
    }
    const separator = pair.indexOf('=');
    const key = decode(separator < 0 ? pair : pair.slice(0, separator));
    if (!key) {
      continue;
    }
    params[key] = separator < 0 ? '' : decode(pair.slice(separator + 1));
  }
  return params;
};

/**
 * True when `finalUrl` (after redirects) is plaintext http while the request
 * started on https. An https endpoint or artifact URL must never be served
 * over http, redirected or otherwise: the update package is the supply chain
 * boundary, and TLS is the only thing authenticating it.
 */
export const isProtocolDowngrade = (
  requestedUrl: string,
  finalUrl?: string | null
): boolean =>
  !!finalUrl && /^https:/i.test(requestedUrl) && /^http:/i.test(finalUrl);

export const enhancedFetch = async (
  url: string,
  params: Parameters<typeof fetch>[1]
): Promise<Response> => {
  // No https -> http retry here, ever. Earlier versions replayed failed
  // idempotent https requests over plaintext http as a "network
  // compatibility" fallback; that silently moved endpoint discovery and
  // package downloads outside TLS. Self-hosted plaintext deployments must
  // configure explicit http:// URLs instead.
  const response = await fetch(url, params).catch((e) => {
    log('fetch error', url, e);
    throw e;
  });
  if (isProtocolDowngrade(url, response?.url)) {
    log('fetch rejected: https redirected to http', url, response.url);
    throw Error(i18n.t('error_insecure_redirect'));
  }
  return response;
};
