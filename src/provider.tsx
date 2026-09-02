// biome-ignore lint/correctness/noUnusedImports: preserve React import for compatibility with older React versions
import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import { type Cresc, type Pushy, sharedState } from './client';
import { ProgressContext, UpdateContext } from './context';
import {
  cInfo,
  currentVersion,
  currentVersionInfo,
  getCurrentVersionInfo,
  packageVersion,
  rolledBackVersion,
} from './core';
import type { CheckResult, ProgressData, UpdateTestPayload } from './type';
import { decideDownload, resolveCheckResult } from './updateFlowCore';
import { assertWeb, isWeb, log, noop, parseQueryParams } from './utils';

export const UpdateProvider = ({
  client,
  children,
}: {
  client: Pushy | Cresc;
  children: ReactNode;
}) => {
  client = useRef(client).current;
  const { options } = client;

  // A second concurrently mounted provider is a hard integration error (the
  // client is a process-level singleton); the client throws on the second
  // claim. Also releases the claim on unmount.
  useEffect(() => client.claimProviderMount(), [client]);

  // options is mutated in place by client.setOptions (its identity never
  // changes), so effects keyed on it would never re-run. The client bumps a
  // version on every setOptions; mirroring it into state re-renders this
  // provider, which re-reads the option fields its effects key on (see the
  // lifecycle effects below).
  const [, setOptionsVersion] = useState(client.optionsVersion);
  useEffect(
    () =>
      client.onOptionsChange(() => {
        setOptionsVersion(client.optionsVersion);
      }),
    [client]
  );

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
    [options.updateStrategy]
  );

  const alertError = useCallback(
    (...args: Parameters<typeof Alert.alert>) => {
      if (options.updateStrategy === 'alwaysAlert') {
        Alert.alert(...args);
      }
    },
    [options.updateStrategy]
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
              : 'update_failed'
          ),
          e.message
        );
      }),
    [client, alertError]
  );

  const switchVersion = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (info?.hash) {
        return client.switchVersion(info.hash);
      }
    },
    [client]
  );

  const switchVersionLater = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (info?.hash) {
        return client.switchVersionLater(info.hash);
      }
    },
    [client]
  );

  const downloadUpdate = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (!info?.update) {
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
    [client, options, alertUpdate, alertError]
  );

  const downloadAndInstallApk = useCallback(
    async (downloadUrl: string) => {
      if (Platform.OS === 'android' && downloadUrl) {
        await client.downloadAndInstallApk(downloadUrl, setProgress);
      }
    },
    [client]
  );

  // The action behind an expired package: install the APK in place on
  // Android, hand every other URL to the system. The URL is server-controlled,
  // so a scheme without a handler (or a malformed value) rejects — from an
  // alert button or the silent branch that must not become an unhandled
  // rejection.
  const openExpiredDownload = useCallback(
    (downloadUrl: string) => {
      if (Platform.OS === 'android' && downloadUrl.endsWith('.apk')) {
        downloadAndInstallApk(downloadUrl).catch(noop);
        return;
      }
      Promise.resolve()
        .then(() => Linking.openURL(downloadUrl))
        .catch((e: any) => {
          log('openURL failed:', downloadUrl, e?.message || e);
          setLastError(e instanceof Error ? e : new Error(String(e)));
        });
    },
    [downloadAndInstallApk]
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
      let info = resolveCheckResult(
        rootInfo,
        {
          packageVersion: client.getEffectivePackageVersion(),
          currentVersion,
          uuid: cInfo.uuid,
        },
        log
      );
      if (
        info.update &&
        (typeof info.hash !== 'string' || info.hash.length === 0)
      ) {
        if (info.expired) {
          // An expired package carries its own action (downloadUrl); a stray
          // `update: true` without a hash is nothing the app could act on, so
          // present the response as expired-only instead of also advertising
          // an update.
          info = { ...info, update: false };
        } else {
          // A malformed rollout/root entry must not produce an alert whose
          // confirm button can never download anything. Surface it to the
          // developer telemetry/logger and present it to the app as no update.
          client.reportInvalidUpdateOnce('missingHash');
          info = { upToDate: true };
        }
      }
      const silentStrategy =
        options.updateStrategy === 'silentAndNow' ||
        options.updateStrategy === 'silentAndLater';
      let unusableRelease: CheckResult | undefined;
      if (info.update && !info.expired) {
        const decision = decideDownload(
          info,
          { currentVersion, rolledBackVersion },
          __DEV__
        );
        if (decision.action === 'none') {
          if (decision.reason === 'noArtifact') {
            // Invalid server data is worth reporting (local rollout guards are
            // expected no-ops and stay silent) — once per bad release. The
            // client reports it from the download attempt, which the silent
            // strategies make below; the alert strategies never get there
            // (no confirm button is shown for an update that cannot
            // download), so only they report from here.
            if (silentStrategy) {
              unusableRelease = info;
            } else {
              client.reportInvalidUpdateOnce('noArtifact', info.hash || '');
            }
          }
          info = { upToDate: true };
        }
      }
      if (info.update) {
        info.description = info.description ?? '';
      }
      updateInfoRef.current = info;
      setUpdateInfo(info);
      if (unusableRelease) {
        // Resolves false once the client has reported the bad release.
        downloadUpdate(unusableRelease).catch(noop);
        return info;
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
            openExpiredDownload(downloadUrl);
            return info;
          }
          alertUpdate(client.t('alert_title'), client.t('alert_app_updated'), [
            {
              text: client.t('alert_update_button'),
              onPress: () => {
                openExpiredDownload(downloadUrl);
              },
            },
          ]);
        }
      } else if (info.update) {
        if (silentStrategy) {
          downloadUpdate(info).catch(noop);
          return info;
        }
        alertUpdate(
          client.t('alert_title'),
          client.t('alert_new_version_found', {
            // A server that omits the name must not leave a literal
            // `{{name}}` in the alert.
            name: info.name || '',
            description: info.description || '',
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
          ]
        );
      }
      return info;
    },
    [
      client,
      options,
      alertUpdate,
      alertError,
      openExpiredDownload,
      downloadUpdate,
    ]
  );

  const markSuccess = client.markSuccess;

  // The lifecycle effects below key on the primitive option values they read
  // (re-read on every render, i.e. after every setOptions), so a setOptions
  // that touches something else — a logger, disableErrorReporting — no longer
  // re-runs a start check, resets the auto-mark timer or re-subscribes
  // AppState. checkUpdate's identity follows the strategy options; the
  // listener and the start check reach it through this ref instead of
  // depending on it.
  const { checkStrategy, autoMarkSuccess, autoMarkSuccessDelayMs } = options;
  const latestCheckUpdate = useRef(checkUpdate);
  useEffect(() => {
    latestCheckUpdate.current = checkUpdate;
  }, [checkUpdate]);

  // (a) Foreground checks: one AppState subscription for as long as the
  // strategy asks for it.
  useEffect(() => {
    if (
      isWeb ||
      (checkStrategy !== 'both' && checkStrategy !== 'onAppResume') ||
      !client.assertDebug('checkUpdate()')
    ) {
      return;
    }
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        latestCheckUpdate.current().catch(noop);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [client, checkStrategy]);

  // (b) Automatic markSuccess: armed once per (autoMarkSuccess, delay); an
  // unrelated setOptions must not push the health confirmation out again.
  useEffect(() => {
    if (isWeb || !autoMarkSuccess || !client.assertDebug('markSuccess()')) {
      return;
    }
    const delay =
      typeof autoMarkSuccessDelayMs === 'number' && autoMarkSuccessDelayMs >= 0
        ? autoMarkSuccessDelayMs
        : 1000;
    const markSuccessTimer = setTimeout(() => {
      // The health check is read when the timer fires, not when it was
      // armed, so a late setOptions still applies.
      const { healthCheck } = client.options;
      (async () => {
        if (healthCheck) {
          let healthy = false;
          try {
            healthy = (await healthCheck()) !== false;
          } catch (e: any) {
            log('healthCheck threw, not marking success:', e?.message || e);
            return;
          }
          if (!healthy) {
            log('healthCheck returned false, not marking success');
            return;
          }
        }
        // Failures are reported and surfaced via the onError subscription.
        await client.markSuccess();
      })().catch(noop);
    }, delay);
    return () => {
      clearTimeout(markSuccessTimer);
    };
  }, [client, autoMarkSuccess, autoMarkSuccessDelayMs]);

  // (c) The start-of-life check runs once per mount, never again because of a
  // setOptions. It still respects the strategy in force at mount: an app that
  // mounts without automatic checks and enables them later gets its one
  // start check at that point.
  const startCheckDone = useRef(false);
  useEffect(() => {
    if (
      startCheckDone.current ||
      (checkStrategy !== 'both' && checkStrategy !== 'onAppStart') ||
      !client.assertDebug('checkUpdate()') ||
      !assertWeb()
    ) {
      return;
    }
    startCheckDone.current = true;
    latestCheckUpdate.current().catch(noop);
  }, [client, checkStrategy]);

  // A dismissErrorAfter change reschedules a running timer, not only the next
  // error's.
  const { dismissErrorAfter } = options;
  useEffect(() => {
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
  }, [lastError, dismissErrorAfter, dismissError]);

  const parseTestPayload = useCallback(
    (payload: UpdateTestPayload) => {
      if (payload?.type?.startsWith('__rnPushy')) {
        if (options.testChannel === false) {
          // Production builds may refuse scanned codes that would pull an
          // arbitrary published version.
          log('test channel disabled, ignoring payload', payload.type);
          return false;
        }
        if (payload.type === '__rnPushyVersionHash') {
          const toHash = payload.data;
          if (typeof toHash !== 'string' || !toHash) {
            log('test payload without a target hash ignored');
            return false;
          }
          sharedState.toHash = toHash;
          // No global logger swap for the duration of the check (it leaked
          // into concurrent checks): the tester gets one alert with the
          // outcome instead of one per logged event.
          checkUpdate({ extra: { toHash } })
            .then(() => {
              const info = updateInfoRef.current;
              if (info?.upToDate) {
                Alert.alert(
                  client.t('alert_info'),
                  client.t('alert_no_update_wait')
                );
              } else if (info?.update) {
                Alert.alert(
                  client.t('alert_info'),
                  JSON.stringify({
                    hash: info.hash,
                    name: info.name,
                    description: info.description,
                  })
                );
              }
            })
            .catch(noop);
        }
        return true;
      }
      return false;
    },
    [checkUpdate, options, client]
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
    [parseTestPayload]
  );

  const restartApp = useCallback(async () => {
    return client.restartApp();
  }, [client]);

  const resetToPackagedBundle = useCallback(
    async (resetOptions?: { restart?: boolean }) => {
      return client.resetToPackagedBundle(resetOptions);
    },
    [client]
  );

  useEffect(() => {
    if (!assertWeb()) {
      return;
    }
    // RN >= 0.87 widens getInitialURL() to `string | null | undefined`.
    const parseLinking = (url?: string | null) => {
      if (!url) {
        return;
      }
      // A plain query-string parse (never throws, see parseQueryParams): a
      // malformed deep link must not become an unhandled rejection / a throw
      // inside the 'url' event handler.
      const params = parseQueryParams(url);
      parseTestPayload({
        type: params.type ?? null,
        data: params.data ?? null,
      });
    };

    Linking.getInitialURL().then(parseLinking).catch(noop);
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
    ]
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
