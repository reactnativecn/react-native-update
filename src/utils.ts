import { Platform } from 'react-native';
import i18n from './i18n';

export function log(...args: any[]) {
  console.log(i18n.t('dev_log_prefix'), ...args);
}

export const isWeb = Platform.OS === 'web';

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
      let pingFinished = false;
      return Promise.race([
        enhancedFetch(url, {
          method: 'HEAD',
        })
          .then(({ status, statusText, url: finalUrl }) => {
            pingFinished = true;
            if (status === 200) {
              return finalUrl;
            }
            log('ping failed', url, status, statusText);
            throw Error(i18n.t('error_ping_failed'));
          })
          .catch(e => {
            pingFinished = true;
            log('ping error', url, e);
            throw e;
          }),
        new Promise((_, reject) =>
          setTimeout(() => {
            reject(Error(i18n.t('error_ping_timeout')));
            if (!pingFinished) {
              log('ping timeout', url);
            }
          }, 5000),
        ),
      ]);
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
    console.warn(i18n.t('dev_web_not_supported'));
    return false;
  }
  return true;
};

// export const isAndroid70AndBelow = () => {
//   // android 7.0 and below devices do not support letsencrypt cert
//   // https://letsencrypt.org/2023/07/10/cross-sign-expiration/
//   return Platform.OS === 'android' && Platform.Version <= 24;
// };

export const enhancedFetch = async (
  url: string,
  params: Parameters<typeof fetch>[1],
  isRetry = false,
): Promise<Response> => {
  return fetch(url, params)
    .then(r => {
      if (r.ok) {
        return r;
      }
      throw Error(
        i18n.t('error_http_status', {
          status: r.status,
          statusText: r.statusText,
        }),
      );
    })
    .catch(e => {
      log('fetch error', url, e);
      if (isRetry) {
        throw e;
      }
      log('trying fallback to http');
      return enhancedFetch(url.replace('https', 'http'), params, true);
    });
};
