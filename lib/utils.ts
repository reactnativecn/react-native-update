import { Platform } from 'react-native';

export function promiseAny<T>(promises: Promise<T>[]) {
  return new Promise<T>((resolve, reject) => {
    let count = 0;

    promises.forEach((promise) => {
      Promise.resolve(promise)
        .then(resolve)
        .catch(() => {
          count++;
          if (count === promises.length) {
            reject(new Error('All promises were rejected'));
          }
        });
    });
  });
}

export function logger(...args: any[]) {
  console.log('Pushy: ', ...args);
}

export function assertRelease() {
  if (__DEV__) {
    throw new Error('react-native-update 只能在 RELEASE 版本中运行.');
  }
}

const ping =
  Platform.OS === 'web'
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
              logger('ping failed', finalUrl, status, statusText);
              throw new Error('Ping failed');
            })
            .catch((e) => {
              pingFinished = true;
              logger('ping error', url, e);
              throw e;
            }),
          new Promise((_, reject) =>
            setTimeout(() => {
              reject(new Error('Ping timeout'));
              if (!pingFinished) {
                logger('ping timeout', url);
              }
            }, 2000),
          ),
        ]);
      };

export const testUrls = async (urls?: string[]) => {
  if (!urls?.length) {
    return null;
  }
  try {
    const ret = await promiseAny(urls.map(ping));
    if (ret) {
      return ret;
    }
  } catch {}
  logger('all ping failed, use first url:', urls[0]);
  return urls[0];
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
) => {
  return fetch(url, params)
    .then((r) => {
      if (r.ok) {
        return r;
      }
      throw new Error(`${r.status} ${r.statusText}`);
    })
    .catch((e) => {
      logger('fetch error', url, e);
      if (isRetry) {
        throw e;
      }
      logger('trying fallback to http');
      return enhancedFetch(url.replace('https', 'http'), params, true);
    });
};
