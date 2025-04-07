import React, {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  NativeEventSubscription,
  AppState,
  Platform,
  Linking,
} from 'react-native';
import { Pushy, Cresc } from './client';
import { currentVersion, packageVersion, getCurrentVersionInfo } from './core';
import { CheckResult, ProgressData, UpdateTestPayload } from './type';
import { UpdateContext } from './context';
import { URL } from 'react-native-url-polyfill';
import { isInRollout } from './isInRollout';
import { log } from './utils';

export const UpdateProvider = ({
  client,
  children,
}: {
  client: Pushy | Cresc;
  children: ReactNode;
}) => {
  client = useRef(client).current;
  const { options } = client;

  const stateListener = useRef<NativeEventSubscription>();
  const [updateInfo, setUpdateInfo] = useState<CheckResult>();
  const updateInfoRef = useRef(updateInfo);
  const [progress, setProgress] = useState<ProgressData>();
  const [lastError, setLastError] = useState<Error>();
  const lastChecking = useRef(0);

  const throwErrorIfEnabled = useCallback(
    (e: Error) => {
      if (options.throwError) {
        throw e;
      }
    },
    [options.throwError],
  );

  const dismissError = useCallback(() => {
    setLastError(undefined);
  }, []);

  const alertUpdate = useCallback(
    (...args: Parameters<typeof Alert.alert>) => {
      if (
        options.updateStrategy === 'alwaysAlert' ||
        options.updateStrategy === 'alertUpdateAndIgnoreError'
      ) {
        Alert.alert(...args);
      }
    },
    [options.updateStrategy],
  );

  const alertError = useCallback(
    (...args: Parameters<typeof Alert.alert>) => {
      if (options.updateStrategy === 'alwaysAlert') {
        Alert.alert(...args);
      }
    },
    [options.updateStrategy],
  );

  const switchVersion = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (info && info.hash) {
        return client.switchVersion(info.hash);
      }
    },
    [client],
  );

  const switchVersionLater = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (info && info.hash) {
        return client.switchVersionLater(info.hash);
      }
    },
    [client],
  );

  const downloadUpdate = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (!info || !info.update) {
        return false;
      }
      try {
        const hash = await client.downloadUpdate(info, setProgress);
        if (!hash) {
          return false;
        }
        stateListener.current && stateListener.current.remove();
        if (options.updateStrategy === 'silentAndNow') {
          client.switchVersion(hash);
          return true;
        } else if (options.updateStrategy === 'silentAndLater') {
          client.switchVersionLater(hash);
          return true;
        }
        alertUpdate('提示', '下载完毕，是否立即更新?', [
          {
            text: '下次再说',
            style: 'cancel',
            onPress: () => {
              client.switchVersionLater(hash);
            },
          },
          {
            text: '立即更新',
            style: 'default',
            onPress: () => {
              client.switchVersion(hash);
            },
          },
        ]);
        return true;
      } catch (e: any) {
        setLastError(e);
        alertError('更新失败', e.message);
        throwErrorIfEnabled(e);
        return false;
      }
    },
    [
      client,
      options.updateStrategy,
      alertUpdate,
      alertError,
      throwErrorIfEnabled,
    ],
  );

  const downloadAndInstallApk = useCallback(
    async (downloadUrl: string) => {
      if (Platform.OS === 'android' && downloadUrl) {
        await client.downloadAndInstallApk(downloadUrl, setProgress);
      }
    },
    [client],
  );

  const checkUpdate = useCallback(
    async ({ extra }: { extra?: Record<string, any> } | undefined = {}) => {
      const now = Date.now();
      if (lastChecking.current && now - lastChecking.current < 1000) {
        return;
      }
      lastChecking.current = now;
      let info: CheckResult;
      try {
        info = await client.checkUpdate(extra);
      } catch (e: any) {
        setLastError(e);
        alertError('更新检查失败', e.message);
        throwErrorIfEnabled(e);
        return;
      }
      if (!info) {
        return;
      }
      const rollout = info.config?.rollout?.[packageVersion];
      if (rollout) {
        if (!isInRollout(rollout)) {
          log(`not in ${rollout}% rollout, ignored`);
          return;
        }
        log(`in ${rollout}% rollout, continue`);
      }
      info.description = info.description ?? '';
      updateInfoRef.current = info;
      setUpdateInfo(info);
      if (info.expired) {
        const { downloadUrl } = info;
        if (downloadUrl && Pushy.apkStatus === null) {
          if (options.updateStrategy === 'silentAndNow') {
            if (Platform.OS === 'android' && downloadUrl.endsWith('.apk')) {
              downloadAndInstallApk(downloadUrl);
            } else {
              Linking.openURL(downloadUrl);
            }
            return info;
          }
          alertUpdate('提示', '您的应用版本已更新，点击更新下载安装新版本', [
            {
              text: '更新',
              onPress: () => {
                if (Platform.OS === 'android' && downloadUrl.endsWith('.apk')) {
                  downloadAndInstallApk(downloadUrl);
                } else {
                  Linking.openURL(downloadUrl);
                }
              },
            },
          ]);
        }
      } else if (info.update) {
        if (
          options.updateStrategy === 'silentAndNow' ||
          options.updateStrategy === 'silentAndLater'
        ) {
          downloadUpdate(info);
          return info;
        }
        alertUpdate(
          '提示',
          '检查到新的版本' + info.name + ',是否下载?\n' + info.description,
          [
            { text: '取消', style: 'cancel' },
            {
              text: '确定',
              style: 'default',
              onPress: () => {
                downloadUpdate();
              },
            },
          ],
        );
      }
      return info;
    },
    [
      client,
      alertError,
      throwErrorIfEnabled,
      options.updateStrategy,
      alertUpdate,
      downloadAndInstallApk,
      downloadUpdate,
    ],
  );

  const markSuccess = client.markSuccess;

  useEffect(() => {
    if (!client.assertDebug()) {
      return;
    }
    const { checkStrategy, dismissErrorAfter, autoMarkSuccess } = options;
    if (autoMarkSuccess) {
      setTimeout(() => {
        markSuccess();
      }, 1000);
    }
    if (checkStrategy === 'both' || checkStrategy === 'onAppResume') {
      stateListener.current = AppState.addEventListener(
        'change',
        nextAppState => {
          if (nextAppState === 'active') {
            checkUpdate();
          }
        },
      );
    }
    if (checkStrategy === 'both' || checkStrategy === 'onAppStart') {
      checkUpdate();
    }
    let dismissErrorTimer: ReturnType<typeof setTimeout>;
    if (typeof dismissErrorAfter === 'number' && dismissErrorAfter > 0) {
      dismissErrorTimer = setTimeout(() => {
        dismissError();
      }, dismissErrorAfter);
    }
    return () => {
      stateListener.current && stateListener.current.remove();
      clearTimeout(dismissErrorTimer);
    };
  }, [checkUpdate, options, dismissError, markSuccess, client]);

  const parseTestPayload = useCallback(
    (payload: UpdateTestPayload) => {
      if (payload && payload.type && payload.type.startsWith('__rnPushy')) {
        const logger = options.logger || (() => {});
        options.logger = ({ type, data }) => {
          logger({ type, data });
          Alert.alert(type, JSON.stringify(data));
        };
        if (payload.type === '__rnPushyVersionHash') {
          checkUpdate({ extra: { toHash: payload.data } }).then(() => {
            if (updateInfoRef.current && updateInfoRef.current.upToDate) {
              Alert.alert(
                'Info',
                'No update found, please wait 10s for the server to generate the patch package',
              );
            }
            options.logger = logger;
          });
        }
        return true;
      }
      return false;
    },
    [checkUpdate, options],
  );

  const parseTestQrCode = useCallback(
    (code: string | UpdateTestPayload) => {
      try {
        const payload = typeof code === 'string' ? JSON.parse(code) : code;
        return parseTestPayload(payload);
      } catch {
        return false;
      }
    },
    [parseTestPayload],
  );

  useEffect(() => {
    const parseLinking = (url: string | null) => {
      if (!url) {
        return;
      }
      const params = new URL(url).searchParams;
      const payload = {
        type: params.get('type'),
        data: params.get('data'),
      };
      parseTestPayload(payload);
    };

    Linking.getInitialURL().then(parseLinking);
    const linkingHandler = ({ url }: { url: string }) => {
      parseLinking(url);
    };
    const linkingListener = Linking.addEventListener('url', linkingHandler);
    return () => {
      if ('removeEventListener' in Linking) {
        (Linking as any).removeEventListener('url', linkingHandler);
      } else {
        linkingListener.remove();
      }
    };
  }, [parseTestPayload]);

  return (
    <UpdateContext.Provider
      value={{
        checkUpdate,
        switchVersion,
        switchVersionLater,
        dismissError,
        updateInfo,
        lastError,
        markSuccess,
        client,
        downloadUpdate,
        packageVersion,
        currentHash: currentVersion,
        progress,
        downloadAndInstallApk,
        getCurrentVersionInfo,
        parseTestQrCode,
      }}>
      {children}
    </UpdateContext.Provider>
  );
};

/** @deprecated Please use `UpdateProvider` instead */
export const PushyProvider = UpdateProvider;
