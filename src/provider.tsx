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
import { Pushy, Cresc, sharedState } from './client';
import {
  currentVersion,
  packageVersion,
  getCurrentVersionInfo,
  currentVersionInfo,
} from './core';
import {
  CheckResult,
  ProgressData,
  UpdateCheckState,
  UPDATE_CHECK_STATUS,
  UpdateTestPayload,
  VersionInfo,
} from './type';
import { UpdateContext } from './context';
import { URL } from 'react-native-url-polyfill';
import { isInRollout } from './isInRollout';
import { assertWeb, log } from './utils';

export const UpdateProvider = ({
  client,
  children,
}: {
  client: Pushy | Cresc;
  children: ReactNode;
}) => {
  client = useRef(client).current;
  const { options } = client;

  const stateListener = useRef<NativeEventSubscription>(undefined);
  const [updateInfo, setUpdateInfo] = useState<CheckResult>();
  const updateInfoRef = useRef(updateInfo);
  const [progress, setProgress] = useState<ProgressData>();
  const [lastError, setLastError] = useState<Error>();
  const [checkState, setCheckStateState] = useState<UpdateCheckState>({
    status: UPDATE_CHECK_STATUS.IDLE,
  });
  const checkStateRef = useRef(checkState);
  const lastChecking = useRef(0);

  const setCheckState = useCallback((nextState: UpdateCheckState) => {
    checkStateRef.current = nextState;
    setCheckStateState(nextState);
  }, []);

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
    if (checkStateRef.current.error) {
      setCheckState({
        ...checkStateRef.current,
        error: undefined,
      });
    }
  }, [setCheckState]);

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

        if (
          options.afterDownloadUpdate &&
          (await options.afterDownloadUpdate(info)) === false
        ) {
          log('afterDownloadUpdate returned false, skipping');
          return false;
        }
        if (options.updateStrategy === 'silentAndNow') {
          client.switchVersion(hash);
          return true;
        } else if (options.updateStrategy === 'silentAndLater') {
          client.switchVersionLater(hash);
          return true;
        }
        alertUpdate(client.t('alert_title'), client.t('alert_update_ready'), [
          {
            text: client.t('alert_next_time'),
            style: 'cancel',
            onPress: () => {
              client.switchVersionLater(hash);
            },
          },
          {
            text: client.t('alert_update_now'),
            style: 'default',
            onPress: () => {
              client.switchVersion(hash);
            },
          },
        ]);
        return true;
      } catch (e: any) {
        setLastError(e);
        alertError(client.t('update_failed'), e.message);
        throwErrorIfEnabled(e);
        return false;
      }
    },
    [client, options, alertUpdate, alertError, throwErrorIfEnabled],
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
    async ({ extra }: { extra?: Partial<{ toHash: string }> } = {}) => {
      const now = Date.now();
      // 频繁重复触发时不再发起新检查，但需要把本次调用标记为跳过。
      if (lastChecking.current && now - lastChecking.current < 1000) {
        if (checkStateRef.current.status !== UPDATE_CHECK_STATUS.CHECKING) {
          setCheckState({
            status: UPDATE_CHECK_STATUS.SKIPPED,
          });
        }
        return;
      }
      lastChecking.current = now;
      setCheckState({
        status: UPDATE_CHECK_STATUS.CHECKING,
      });
      let result: CheckResult | void;
      let rootInfo: CheckResult | undefined;
      try {
        result = await client.checkUpdate(extra);
        rootInfo = { ...result };
      } catch (e: any) {
        setLastError(e);
        setCheckState({
          status: UPDATE_CHECK_STATUS.ERROR,
          error: e,
        });
        alertError(client.t('error_update_check_failed'), e.message);
        throwErrorIfEnabled(e);
        return;
      }
      let nextCheckStatus: UpdateCheckState['status'];
      let nextCheckError: Error | undefined;
      // client.checkUpdate 默认会兜底返回旧结果或空对象，这里只额外标记状态，不截断原有流程。
      if (client.lastCheckError) {
        nextCheckStatus = UPDATE_CHECK_STATUS.ERROR;
        nextCheckError = client.lastCheckError;
        setLastError(client.lastCheckError);
        alertError(
          client.t('error_update_check_failed'),
          client.lastCheckError.message,
        );
      } else if (!result) {
        // undefined 表示本次调用被内部策略跳过，例如 beforeCheckUpdate 返回 false。
        nextCheckStatus = UPDATE_CHECK_STATUS.SKIPPED;
      } else {
        nextCheckStatus = UPDATE_CHECK_STATUS.COMPLETED;
      }
      if (!rootInfo) {
        setCheckState({
          status: nextCheckStatus,
          error: nextCheckError,
        });
        return;
      }
      const versions = [rootInfo.expVersion, rootInfo].filter(
        Boolean,
      ) as VersionInfo[];
      delete rootInfo.expVersion;
      for (const versionInfo of versions) {
        const info: CheckResult = {
          ...rootInfo,
          ...versionInfo,
        };
        const rollout = info.config?.rollout?.[packageVersion];
        if (info.update && rollout) {
          if (!isInRollout(rollout)) {
            log(`${info.name} not in ${rollout}% rollout, ignored`);
            continue;
          }
          log(`${info.name} in ${rollout}% rollout, continue`);
        }
        if (info.update) {
          info.description = info.description ?? '';
        }
        updateInfoRef.current = info;
        setUpdateInfo(info);
        if (nextCheckStatus === UPDATE_CHECK_STATUS.COMPLETED) {
          setCheckState({
            status: nextCheckStatus,
            result: info,
            error: nextCheckError,
          });
        } else {
          setCheckState({
            status: nextCheckStatus,
            error: nextCheckError,
          });
        }
        if (info.expired) {
          if (
            options.onPackageExpired &&
            (await options.onPackageExpired(info)) === false
          ) {
            log('onPackageExpired returned false, skipping');
            return;
          }
          const { downloadUrl } = info;
          if (downloadUrl && sharedState.apkStatus === null) {
            if (options.updateStrategy === 'silentAndNow') {
              if (Platform.OS === 'android' && downloadUrl.endsWith('.apk')) {
                downloadAndInstallApk(downloadUrl);
              } else {
                Linking.openURL(downloadUrl);
              }
              return info;
            }
            alertUpdate(
              client.t('alert_title'),
              client.t('alert_app_updated'),
              [
                {
                  text: client.t('alert_update_button'),
                  onPress: () => {
                    if (
                      Platform.OS === 'android' &&
                      downloadUrl.endsWith('.apk')
                    ) {
                      downloadAndInstallApk(downloadUrl);
                    } else {
                      Linking.openURL(downloadUrl);
                    }
                  },
                },
              ],
            );
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
            client.t('alert_title'),
            client.t('alert_new_version_found', {
              name: info.name!,
              description: info.description!,
            }),
            [
              { text: client.t('alert_cancel'), style: 'cancel' },
              {
                text: client.t('alert_confirm'),
                style: 'default',
                onPress: () => {
                  downloadUpdate();
                },
              },
            ],
          );
        }
        return info;
      }
      setCheckState({
        status: nextCheckStatus,
        error: nextCheckError,
      });
    },
    [
      client,
      alertError,
      throwErrorIfEnabled,
      setCheckState,
      options,
      alertUpdate,
      downloadAndInstallApk,
      downloadUpdate,
    ],
  );

  const markSuccess = client.markSuccess;

  useEffect(() => {
    if (!client.assertDebug('checkUpdate()')) {
      return;
    }
    if (!assertWeb()) {
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
          const toHash = payload.data;
          sharedState.toHash = toHash;
          checkUpdate({ extra: { toHash } }).then(() => {
            if (updateInfoRef.current && updateInfoRef.current.upToDate) {
              Alert.alert(
                client.t('alert_info'),
                client.t('alert_no_update_wait'),
              );
            }
            options.logger = logger;
          });
        }
        return true;
      }
      return false;
    },
    [checkUpdate, options, client],
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

  const restartApp = useCallback(async () => {
    return client.restartApp();
  }, [client]);

  useEffect(() => {
    if (!assertWeb()) {
      return;
    }
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
        currentVersionInfo,
        parseTestQrCode,
        restartApp,
        checkState,
      }}>
      {children}
    </UpdateContext.Provider>
  );
};

/** @deprecated Please use `UpdateProvider` instead */
export const PushyProvider = UpdateProvider;
