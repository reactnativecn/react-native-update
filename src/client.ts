import {
  DeviceEventEmitter,
  EmitterSubscription,
  Platform,
} from 'react-native';
import {
  PushyModule,
  buildTime,
  cInfo,
  currentVersion,
  currentVersionInfo,
  isFirstTime,
  isRolledBack,
  packageVersion,
  pushyNativeEventEmitter,
  rolledBackVersion,
  setLocalHashInfo,
} from './core';
import { PermissionsAndroid } from './permissions';
import {
  CheckResult,
  ClientOptions,
  EventType,
  ProgressData,
  UpdateCheckState,
  UpdateServerConfig,
} from './type';
import {
  assertWeb,
  DEFAULT_FETCH_TIMEOUT_MS,
  emptyObj,
  fetchWithTimeout,
  info,
  joinUrls,
  log,
  noop,
  promiseAny,
  testUrls,
} from './utils';
import i18n from './i18n';
import { dedupeEndpoints, executeEndpointFallback } from './endpoint';

const SERVER_PRESETS = {
  // cn
  Pushy: {
    main: ['https://update.react-native.cn/api', 'https://update.reactnative.cn/api'],
    queryUrls: [
      'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json',
    ],
  },
  // i18n
  Cresc: {
    main: ['https://api.cresc.dev', 'https://api.cresc.app'],
    queryUrls: [
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints_cresc.json',
    ],
  },
};

const cloneServerConfig = (server: UpdateServerConfig): UpdateServerConfig => ({
  main: dedupeEndpoints([...(server.main || [])]),
  queryUrls: server.queryUrls ? [...server.queryUrls] : undefined,
});

const excludeConfiguredEndpoints = (
  endpoints: string[],
  configuredEndpoints: string[],
) => {
  const configured = new Set(configuredEndpoints);
  return endpoints.filter(endpoint => !configured.has(endpoint));
};

assertWeb();

const defaultClientOptions: ClientOptions = {
  appKey: '',
  autoMarkSuccess: true,
  updateStrategy: __DEV__ ? 'alwaysAlert' : 'alertUpdateAndIgnoreError',
  checkStrategy: 'both',
  logger: noop,
  debug: false,
  throwError: false,
};

export const sharedState: {
  progressHandlers: Record<string, EmitterSubscription>;
  downloadedHash?: string;
  toHash?: string;
  apkStatus: 'downloading' | 'downloaded' | null;
  marked: boolean;
  applyingUpdate: boolean;
} = {
  progressHandlers: {},
  downloadedHash: undefined,
  apkStatus: null,
  marked: false,
  applyingUpdate: false,
};

const assertHash = (hash: string) => {
  if (!sharedState.downloadedHash) {
    return;
  }
  if (hash !== sharedState.downloadedHash) {
    log(`use downloaded hash ${sharedState.downloadedHash} first`);
    return;
  }
  return true;
};

// for China users
export class Pushy {
  options = defaultClientOptions;
  clientType: 'Pushy' | 'Cresc' = 'Pushy';
  lastChecking?: number;
  lastRespJson?: Promise<CheckResult>;

  version = cInfo.rnu;
  loggerPromise = (() => {
    let resolve: (value?: unknown) => void = () => {};
    const promise = new Promise(res => {
      resolve = res;
    });
    return {
      promise,
      resolve,
    };
  })();

  constructor(options: ClientOptions, clientType?: 'Pushy' | 'Cresc') {
    this.clientType = clientType || 'Pushy';
    this.options.server = cloneServerConfig(SERVER_PRESETS[this.clientType]);

    i18n.setLocale(options.locale ?? this.clientType === 'Pushy' ? 'zh' : 'en');

    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      if (!options.appKey) {
        throw Error(i18n.t('error_appkey_required'));
      }
    }

    this.setOptions(options);
    if (isRolledBack) {
      this.report({
        type: 'rollback',
        data: {
          rolledBackVersion,
        },
      });
    }
  }

  setOptions = (options: Partial<ClientOptions>) => {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        (this.options as any)[key] =
          key === 'server'
            ? cloneServerConfig(value as UpdateServerConfig)
            : value;
        if (key === 'logger') {
          this.loggerPromise.resolve();
        }
      }
    }
  };

  /**
   * Get translated text based on current clientType
   * @param key - Translation key
   * @param values - Values for interpolation (optional)
   * @returns Translated string
   */
  t = (key: string, values?: Record<string, string | number>) => {
    return i18n.t(key as any, values);
  };

  report = async ({
    type,
    message = '',
    data = {},
  }: {
    type: EventType;
    message?: string;
    data?: Record<string, string | number>;
  }) => {
    log(type + ' ' + message);
    await this.loggerPromise.promise;
    const { logger = noop, appKey } = this.options;
    const overridePackageVersion = this.options.overridePackageVersion;
    logger({
      type,
      data: {
        appKey,
        currentVersion,
        cInfo,
        packageVersion,
        overridePackageVersion,
        buildTime,
        message,
        ...currentVersionInfo,
        ...data,
      },
    });
  };
  throwIfEnabled = (e: Error) => {
    if (this.options.throwError) {
      throw e;
    }
  };
  notifyAfterCheckUpdate = (state: UpdateCheckState) => {
    const { afterCheckUpdate } = this.options;
    if (!afterCheckUpdate) {
      return;
    }
    // 这里仅做状态通知，不阻塞原有检查流程
    Promise.resolve(afterCheckUpdate(state)).catch((error: any) => {
      log('afterCheckUpdate failed:', error?.message || error);
    });
  };
  getCheckUrl = (endpoint: string) => {
    return `${endpoint}/checkUpdate/${this.options.appKey}`;
  };
  getConfiguredCheckEndpoints = () => {
    const { server } = this.options;
    if (!server) {
      return [];
    }
    return dedupeEndpoints(server.main);
  };
  getRemoteEndpoints = async () => {
    const { server } = this.options;
    if (!server?.queryUrls?.length) {
      return [];
    }
    try {
      const resp = await promiseAny(
        server.queryUrls.map(queryUrl =>
          fetchWithTimeout(queryUrl, {}, DEFAULT_FETCH_TIMEOUT_MS),
        ),
      );
      const remoteEndpoints = await resp.json();
      log('fetch endpoints:', remoteEndpoints);
      if (Array.isArray(remoteEndpoints)) {
        return excludeConfiguredEndpoints(
          dedupeEndpoints(
          remoteEndpoints.filter(
            (endpoint): endpoint is string => typeof endpoint === 'string',
          ),
          ),
          this.getConfiguredCheckEndpoints(),
        );
      }
    } catch (e) {
      log('failed to fetch endpoints from: ', server.queryUrls, e);
    }
    return [];
  };
  requestCheckResult = async (
    endpoint: string,
    fetchPayload: Parameters<typeof fetch>[1],
  ) => {
    const resp = await fetchWithTimeout(
      this.getCheckUrl(endpoint),
      fetchPayload,
      DEFAULT_FETCH_TIMEOUT_MS,
    );

    if (!resp.ok) {
      const respText = await resp.text();
      throw Error(
        this.t('error_http_status', {
          status: resp.status,
          statusText: respText,
        }),
      );
    }

    return (await resp.json()) as CheckResult;
  };
  fetchCheckResult = async (fetchPayload: Parameters<typeof fetch>[1]) => {
    const { endpoint, value } = await executeEndpointFallback<CheckResult>({
      configuredEndpoints: this.getConfiguredCheckEndpoints(),
      getRemoteEndpoints: this.getRemoteEndpoints,
      tryEndpoint: async currentEndpoint => {
        try {
          return await this.requestCheckResult(currentEndpoint, fetchPayload);
        } catch (e) {
          log('check endpoint failed', currentEndpoint, e);
          throw e;
        }
      },
      onFirstFailure: ({ error }) => {
        this.report({
          type: 'errorChecking',
          message: this.t('error_cannot_connect_backup', {
            message: error.message,
          }),
        });
      },
    });

    log('check endpoint success', endpoint);
    return value;
  };
  assertDebug = (matter: string) => {
    if (__DEV__ && !this.options.debug) {
      info(this.t('dev_debug_disabled', { matter }));
      return false;
    }
    return true;
  };
  markSuccess = async () => {
    if (sharedState.marked || __DEV__ || !isFirstTime) {
      return;
    }
    await Promise.resolve(PushyModule.markSuccess());
    sharedState.marked = true;
    await this.report({ type: 'markSuccess' });
  };
  switchVersion = async (hash: string) => {
    if (!this.assertDebug('switchVersion()')) {
      return;
    }
    if (assertHash(hash) && !sharedState.applyingUpdate) {
      log('switchVersion: ' + hash);
      sharedState.applyingUpdate = true;
      return PushyModule.reloadUpdate({ hash });
    }
  };

  switchVersionLater = async (hash: string) => {
    if (!this.assertDebug('switchVersionLater()')) {
      return;
    }
    if (assertHash(hash)) {
      log('switchVersionLater: ' + hash);
      return PushyModule.setNeedUpdate({ hash });
    }
  };
  checkUpdate = async (extra?: Record<string, any>) => {
    if (!this.assertDebug('checkUpdate()')) {
      this.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    if (!assertWeb()) {
      this.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    if (
      this.options.beforeCheckUpdate &&
      (await this.options.beforeCheckUpdate()) === false
    ) {
      log('beforeCheckUpdate returned false, skipping check');
      this.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    const now = Date.now();
    if (
      this.lastRespJson &&
      this.lastChecking &&
      now - this.lastChecking < 1000 * 5
    ) {
      const result = await this.lastRespJson;
      this.notifyAfterCheckUpdate({ status: 'completed', result });
      return result;
    }
    this.lastChecking = now;
    const fetchBody: Record<string, any> = {
      packageVersion: this.options.overridePackageVersion || packageVersion,
      hash: currentVersion,
      buildTime,
      cInfo,
      ...extra,
    };
    if (__DEV__) {
      delete fetchBody.buildTime;
    }
    const stringifyBody = JSON.stringify(fetchBody);
    // harmony fetch body is not string
    let body: any = fetchBody;
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      body = stringifyBody;
    }
    const fetchPayload = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    };
    const previousRespJson = this.lastRespJson;
    try {
      this.report({
        type: 'checking',
        message: this.options.appKey + ': ' + stringifyBody,
      });
      const respJsonPromise = this.fetchCheckResult(fetchPayload);
      this.lastRespJson = respJsonPromise;
      const result: CheckResult = await respJsonPromise;

      log('checking result:', result);

      this.notifyAfterCheckUpdate({ status: 'completed', result });
      return result;
    } catch (e: any) {
      this.lastRespJson = previousRespJson;
      const errorMessage =
        e?.message || this.t('error_cannot_connect_server');
      this.report({
        type: 'errorChecking',
        message: errorMessage,
      });
      this.notifyAfterCheckUpdate({ status: 'error', error: e });
      this.throwIfEnabled(e);
      return previousRespJson ? await previousRespJson : emptyObj;
    }
  };
  getBackupEndpoints = async () => {
    const { server } = this.options;
    if (!server) {
      return [];
    }
    const remoteEndpoints = await this.getRemoteEndpoints();
    return excludeConfiguredEndpoints(
      dedupeEndpoints(remoteEndpoints),
      this.getConfiguredCheckEndpoints(),
    );
  };
  downloadUpdate = async (
    updateInfo: CheckResult,
    onDownloadProgress?: (data: ProgressData) => void,
  ) => {
    const {
      hash,
      diff,
      pdiff,
      full,
      paths = [],
      name,
      description = '',
      metaInfo,
    } = updateInfo;
    if (
      this.options.beforeDownloadUpdate &&
      (await this.options.beforeDownloadUpdate(updateInfo)) === false
    ) {
      log('beforeDownloadUpdate returned false, skipping download');
      return;
    }
    if (!updateInfo.update || !hash) {
      return;
    }
    if (rolledBackVersion === hash) {
      log(`rolledback hash ${rolledBackVersion}, ignored`);
      return;
    }
    if (sharedState.downloadedHash === hash) {
      log(`duplicated downloaded hash ${sharedState.downloadedHash}, ignored`);
      return sharedState.downloadedHash;
    }
    if (sharedState.progressHandlers[hash]) {
      return;
    }
    const patchStartTime = Date.now();
    if (onDownloadProgress) {
      // @ts-expect-error harmony not in existing platforms
      if (Platform.OS === 'harmony') {
        sharedState.progressHandlers[hash] = DeviceEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          progressData => {
            if (progressData.hash === hash) {
              onDownloadProgress(progressData);
            }
          },
        );
      } else {
        sharedState.progressHandlers[hash] =
          pushyNativeEventEmitter.addListener(
            'RCTPushyDownloadProgress',
            progressData => {
              if (progressData.hash === hash) {
                onDownloadProgress(progressData);
              }
            },
          );
      }
    }
    let succeeded = '';
    this.report({
      type: 'downloading',
      data: {
        newVersion: hash,
      },
    });
    let lastError: any;
    let errorMessages: string[] = [];
    const diffUrl = await testUrls(joinUrls(paths, diff));
    if (diffUrl && !__DEV__) {
      log('downloading diff');
      try {
        await PushyModule.downloadPatchFromPpk({
          updateUrl: diffUrl,
          hash,
          originHash: currentVersion,
        });
        succeeded = 'diff';
      } catch (e: any) {
        const errorMessage = this.t('error_diff_failed', {
          message: e.message,
        });
        errorMessages.push(errorMessage);
        lastError = Error(errorMessage);
        log(errorMessage);
      }
    }
    if (!succeeded) {
      const pdiffUrl = await testUrls(joinUrls(paths, pdiff));
      if (pdiffUrl && !__DEV__) {
        log('downloading pdiff');
        try {
          await PushyModule.downloadPatchFromPackage({
            updateUrl: pdiffUrl,
            hash,
          });
          succeeded = 'pdiff';
        } catch (e: any) {
          const errorMessage = this.t('error_pdiff_failed', {
            message: e.message,
          });
          errorMessages.push(errorMessage);
          lastError = Error(errorMessage);
          log(errorMessage);
        }
      }
    }
    if (!succeeded) {
      const fullUrl = await testUrls(joinUrls(paths, full));
      if (fullUrl) {
        log('downloading full patch');
        try {
          await PushyModule.downloadFullUpdate({
            updateUrl: fullUrl,
            hash,
          });
          succeeded = 'full';
        } catch (e: any) {
          const errorMessage = this.t('error_full_patch_failed', {
            message: e.message,
          });
          errorMessages.push(errorMessage);
          lastError = Error(errorMessage);
          log(errorMessage);
        }
      } else if (__DEV__) {
        log(this.t('dev_incremental_update_disabled'));
        succeeded = 'full';
      }
    }
    if (sharedState.progressHandlers[hash]) {
      sharedState.progressHandlers[hash].remove();
      delete sharedState.progressHandlers[hash];
    }
    if (!succeeded) {
      this.report({
        type: 'errorUpdate',
        data: { newVersion: hash },
        message: errorMessages.join(';'),
      });
      if (lastError) {
        throw lastError;
      }
      return;
    } else {
      const duration = Date.now() - patchStartTime;
      const data: Record<string, any> = {
        newVersion: hash,
        diff: succeeded,
        duration,
      };
      if (errorMessages.length > 0) {
        data.error = errorMessages.join(';');
      }
      this.report({
        type: 'downloadSuccess',
        data,
      });
    }
    log(`downloaded ${succeeded} hash:`, hash);
    const hashInfo: Record<string, any> = {
      name,
      description,
      metaInfo,
    };
    if (sharedState.toHash === hash) {
      hashInfo.debugChannel = true;
    }
    setLocalHashInfo(hash, hashInfo);
    sharedState.downloadedHash = hash;
    return hash;
  };
  downloadAndInstallApk = async (
    url: string,
    onDownloadProgress?: (data: ProgressData) => void,
  ) => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (sharedState.apkStatus === 'downloading') {
      return;
    }
    if (sharedState.apkStatus === 'downloaded') {
      this.report({ type: 'errorInstallApk' });
      this.throwIfEnabled(Error('errorInstallApk'));
      return;
    }
    if (Platform.Version <= 23) {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          this.report({ type: 'rejectStoragePermission' });
          this.throwIfEnabled(Error('rejectStoragePermission'));
          return;
        }
      } catch (e: any) {
        this.report({ type: 'errorStoragePermission' });
        this.throwIfEnabled(e);
        return;
      }
    }
    sharedState.apkStatus = 'downloading';
    this.report({ type: 'downloadingApk' });
    const progressKey = 'downloadingApk';
    if (onDownloadProgress) {
      if (sharedState.progressHandlers[progressKey]) {
        sharedState.progressHandlers[progressKey].remove();
      }
      sharedState.progressHandlers[progressKey] =
        pushyNativeEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          (progressData: ProgressData) => {
            if (progressData.hash === progressKey) {
              onDownloadProgress(progressData);
            }
          },
        );
    }
    await PushyModule.downloadAndInstallApk({
      url,
      target: 'update.apk',
      hash: progressKey,
    }).catch(() => {
      sharedState.apkStatus = null;
      this.report({ type: 'errorDownloadAndInstallApk' });
      this.throwIfEnabled(Error('errorDownloadAndInstallApk'));
    });
    sharedState.apkStatus = 'downloaded';
    if (sharedState.progressHandlers[progressKey]) {
      sharedState.progressHandlers[progressKey].remove();
      delete sharedState.progressHandlers[progressKey];
    }
  };
  restartApp = async () => {
    return PushyModule.restartApp();
  };
}

// for international users
export class Cresc extends Pushy {
  constructor(options: ClientOptions) {
    super(options, 'Cresc');
  }
}
