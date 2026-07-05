import { Platform } from 'react-native';
import i18n from './i18n';

export function log(...args: any[]) {
  console.log(i18n.t('dev_log_prefix'), ...args);
}

export function info(...args: any[]) {
  console.info(i18n.t('dev_log_prefix'), ...args);
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

    promises.forEach(promise => {
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

export const emptyObj = {};
export const noop = () => {};
const emptyModuleTarget: Record<string, typeof noop> = {};
export const emptyModule = new Proxy(
  emptyModuleTarget,
  {
    get(_target, _prop) {
      return noop;
    },
  },
);

const ping = isWeb
  ? Promise.resolve
  : async (url: string) => {
      try {
        const { status, statusText, url: finalUrl } = await fetchWithTimeout(
          url,
          {
            method: 'HEAD',
          },
          DEFAULT_FETCH_TIMEOUT_MS,
        );
        if (status === 200) {
          return finalUrl;
        }
        log('ping failed', url, status, statusText);
        throw Error(i18n.t('error_ping_failed'));
      } catch (e) {
        log('ping error', url, e);
        throw e;
      }
    };

export function joinUrls(paths: string[], fileName?: string) {
  if (fileName) {
    return paths.map(path => {
      const normalizedPath = path.replace(/\/+$/, '');
      // Keep explicit http(s) URLs for local/self-hosted update sources.
      const baseUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedPath)
        ? normalizedPath
        : `https://${normalizedPath}`;
      return `${baseUrl}/${fileName}`;
    });
  }
}

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
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> => {
  // Abort the underlying request on timeout instead of racing a timer: with
  // Promise.race the losing fetch kept running (and kept the connection busy)
  // long after the caller had already moved on.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    log('fetch timeout', url);
    controller.abort();
  }, timeoutMs);

  return enhancedFetch(url, { ...params, signal: controller.signal })
    .catch((e: any) => {
      if (controller.signal.aborted) {
        throw Error(i18n.t('error_ping_timeout'));
      }
      throw e;
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
};

const isIdempotentRequest = (params: Parameters<typeof fetch>[1]) => {
  const method = params?.method?.toUpperCase() ?? 'GET';
  return method === 'GET' || method === 'HEAD';
};

export const enhancedFetch = async (
  url: string,
  params: Parameters<typeof fetch>[1],
  isRetry = false,
): Promise<Response> => {
  return fetch(url, params)
    .catch(e => {
      log('fetch error', url, e);
      if (
        isRetry ||
        (params as any)?.signal?.aborted ||
        !url.startsWith('https:') ||
        // Never replay non-idempotent requests (e.g. the checkUpdate POST)
        // over plaintext http: the server may have processed the original.
        !isIdempotentRequest(params)
      ) {
        throw e;
      }
      log('trying fallback to http');
      return enhancedFetch(url.replace(/^https:/, 'http:'), params, true);
    });
};
