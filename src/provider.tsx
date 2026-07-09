import React, {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
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
  UpdateTestPayload,
} from './type';
import { ProgressContext, UpdateContext } from './context';
import { URL } from 'react-native-url-polyfill';
import { resolveCheckResult } from './resolveCheckResult';
import { assertWeb, log, noop } from './utils';

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

  // All client errors flow through this single subscription (regardless of
  // throwError), so the catches below only handle flow control and never
  // duplicate the lastError/Alert surfacing.
  useEffect(
    () =>
      client.onError((e, eventType) => {
        setLastError(e);
        alertError(
          client.t(
            eventType === 'errorChecking'
              ? 'error_update_check_failed'
              : 'update_failed',
          ),
          e.message,
        );
      }),
    [client, alertError],
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

        if (
          options.afterDownloadUpdate &&
          (await options.afterDownloadUpdate(info)) === false
        ) {
          log('afterDownloadUpdate returned false, skipping');
          return false;
        }
        if (options.updateStrategy === 'silentAndNow') {
          // Failures are surfaced via the onError subscription above.
          client.switchVersion(hash).catch(noop);
          return true;
        } else if (options.updateStrategy === 'silentAndLater') {
          client.switchVersionLater(hash).catch(noop);
          return true;
        }
        alertUpdate(client.t('alert_title'), client.t('alert_update_ready'), [
          {
            text: client.t('alert_next_time'),
            style: 'cancel',
            onPress: () => {
              client.switchVersionLater(hash).catch(noop);
            },
          },
          {
            text: client.t('alert_update_now'),
            style: 'default',
            onPress: () => {
              client.switchVersion(hash).catch(noop);
            },
          },
        ]);
        return true;
      } catch (e: any) {
        // Client pipeline errors were already surfaced via the onError
        // subscription; errors thrown by user hooks (afterDownloadUpdate)
        // bypass the pipeline and are surfaced here. Asking the client
        // instead of checking `e.code` matters: axios/system errors carry
        // their own code without ever entering the pipeline.
        if (!client.wasEmitted(e)) {
          setLastError(e);
          alertError(client.t('update_failed'), e.message);
        }
        if (options.throwError) {
          throw e;
        }
        return false;
      }
    },
    [client, options, alertUpdate, alertError],
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
      // No throttle here: the client already dedupes checks via its 5s
      // response cache, and a second throttle layer silently returned
      // undefined, indistinguishable from a failed check.
      let rootInfo: CheckResult | undefined;
      try {
        rootInfo = await client.checkUpdate(extra);
      } catch (e: any) {
        // Client pipeline errors were already surfaced via the onError
        // subscription; errors thrown by user hooks (beforeCheckUpdate)
        // bypass the pipeline and are surfaced here (see wasEmitted).
        if (!client.wasEmitted(e)) {
          setLastError(e);
          alertError(client.t('error_update_check_failed'), e.message);
        }
        if (options.throwError) {
          throw e;
        }
        return;
      }
      if (!rootInfo) {
        // Check was skipped or failed with no cached result; keep the last
        // known updateInfo instead of overwriting it with an empty object.
        return;
      }
      const info = resolveCheckResult(rootInfo);
      if (info.update) {
        info.description = info.description ?? '';
      }
      updateInfoRef.current = info;
      setUpdateInfo(info);
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
              downloadAndInstallApk(downloadUrl).catch(noop);
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
                    downloadAndInstallApk(downloadUrl).catch(noop);
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
          downloadUpdate(info).catch(noop);
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
                downloadUpdate().catch(noop);
              },
            },
          ],
        );
      }
      return info;
    },
    [
      client,
      options,
      alertUpdate,
      alertError,
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
    const { checkStrategy, autoMarkSuccess } = options;
    let markSuccessTimer: ReturnType<typeof setTimeout> | undefined;
    if (autoMarkSuccess) {
      markSuccessTimer = setTimeout(() => {
        // Failures are reported and surfaced via the onError subscription.
        Promise.resolve(markSuccess()).catch(noop);
      }, 1000);
    }
    if (checkStrategy === 'both' || checkStrategy === 'onAppResume') {
      stateListener.current = AppState.addEventListener(
        'change',
        nextAppState => {
          if (nextAppState === 'active') {
            checkUpdate().catch(noop);
          }
        },
      );
    }
    if (checkStrategy === 'both' || checkStrategy === 'onAppStart') {
      checkUpdate().catch(noop);
    }
    return () => {
      if (markSuccessTimer) {
        clearTimeout(markSuccessTimer);
      }
      stateListener.current && stateListener.current.remove();
    };
  }, [checkUpdate, options, dismissError, markSuccess, client]);

  useEffect(() => {
    const { dismissErrorAfter } = options;
    if (
      lastError &&
      typeof dismissErrorAfter === 'number' &&
      dismissErrorAfter > 0
    ) {
      const dismissErrorTimer = setTimeout(() => {
        dismissError();
      }, dismissErrorAfter);
      return () => {
        clearTimeout(dismissErrorTimer);
      };
    }
  }, [lastError, options, dismissError]);

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
          checkUpdate({ extra: { toHash } })
            .then(() => {
              if (updateInfoRef.current && updateInfoRef.current.upToDate) {
                Alert.alert(
                  client.t('alert_info'),
                  client.t('alert_no_update_wait'),
                );
              }
            })
            .catch(noop)
            .finally(() => {
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
      } catch (e: any) {
        log('parseTestQrCode: invalid payload', e?.message || e);
        return false;
      }
    },
    [parseTestPayload],
  );

  const restartApp = useCallback(async () => {
    return client.restartApp();
  }, [client]);

  const resetToPackagedBundle = useCallback(
    async (resetOptions?: { restart?: boolean }) => {
      return client.resetToPackagedBundle(resetOptions);
    },
    [client],
  );

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

  // progress lives in its own context (see context.ts), so this value only
  // changes when the update state itself changes, not on every progress tick.
  const contextValue = useMemo(
    () => ({
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
      downloadAndInstallApk,
      getCurrentVersionInfo,
      currentVersionInfo,
      parseTestQrCode,
      restartApp,
      resetToPackagedBundle,
    }),
    [
      checkUpdate,
      switchVersion,
      switchVersionLater,
      dismissError,
      updateInfo,
      lastError,
      markSuccess,
      client,
      downloadUpdate,
      downloadAndInstallApk,
      parseTestQrCode,
      restartApp,
      resetToPackagedBundle,
    ],
  );

  return (
    <UpdateContext.Provider value={contextValue}>
      <ProgressContext.Provider value={progress}>
        {children}
      </ProgressContext.Provider>
    </UpdateContext.Provider>
  );
};

/** @deprecated Please use `UpdateProvider` instead */
export const PushyProvider = UpdateProvider;
