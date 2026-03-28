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
class EmptyModule {
  constructor() {
    return new Proxy(this, {
      get() {
        return noop;
      },
    });
  }
}
export const emptyModule = new EmptyModule();

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
    return paths.map(path => `https://${path}/${fileName}`);
  }
}

export const testUrls = async (urls?: string[]) => {
  if (!urls?.length) {
    return null;
  }

  try {
    const ret = await promiseAny(urls.map(ping));
    if (ret) {
      log('ping success, use url:', ret);
      return ret;
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

export const fetchWithTimeout = (
  url: string,
  params: Parameters<typeof fetch>[1],
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> => {
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
};

export const enhancedFetch = async (
  url: string,
  params: Parameters<typeof fetch>[1],
  isRetry = false,
): Promise<Response> => {
  return fetch(url, params)
    .catch(e => {
      log('fetch error', url, e);
      if (isRetry) {
        throw e;
      }
      log('trying fallback to http');
      return enhancedFetch(url.replace('https', 'http'), params, true);
    });
};
