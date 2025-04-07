import { Platform } from 'react-native';

export function logger(...args: any[]) {
  console.log('Pushy: ', ...args);
}

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
          fetch(url, {
            method: 'HEAD',
          })
            .then(({ status, statusText }) => {
              pingFinished = true;
              if (status === 200) {
                return url;
              }
              logger('ping failed', url, status, statusText);
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
  const ret = await promiseAny(urls.map(ping));
  if (ret) {
    return ret;
  }
  logger('all ping failed, use first url:', urls[0]);
  return urls[0];
};
