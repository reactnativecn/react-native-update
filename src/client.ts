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
  hbcTransformVersion,
  isFirstTime,
  isRolledBack,
  packageVersion,
  pushyNativeEventEmitter,
  rolledBackVersion,
  setLocalHashInfo,
} from './core';
import { PermissionsAndroid } from './permissions';
import {
  BeforeReloadContext,
  CheckResult,
  ClientOptions,
  EventType,
  ProgressData,
  UpdateCheckState,
  UpdateServerConfig,
} from './type';
import {
  assertWeb,
  computeProgress,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  info,
  joinUrls,
  log,
  noop,
  promiseAny,
  testUrls,
} from './utils';
import i18n from './i18n';
import { toUpdateError, UpdateError, UpdateErrorCode } from './error';
import { dedupeEndpoints, executeEndpointFallback } from './endpoint';
import {
  resolveServerEventHash,
  resolveServerEventType,
  truncateDetail,
} from './telemetry';

/**
 * Receives every error the client reports, alongside the report event type.
 * The UpdateProvider subscribes to surface errors as lastError/Alert; user
 * code can subscribe too. Listeners run before any throwError rethrow.
 */
export type UpdateErrorListener = (
  error: UpdateError,
  eventType: EventType,
) => void;

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
  downloadingTasks: Record<string, Promise<string | undefined>>;
  downloadedHash?: string;
  toHash?: string;
  apkStatus: 'downloading' | 'downloaded' | null;
  marked: boolean;
  applyingUpdate: boolean;
} = {
  progressHandlers: {},
  downloadingTasks: {},
  downloadedHash: undefined,
  apkStatus: null,
  marked: false,
  applyingUpdate: false,
};

const assertHash = (hash: string) => {
  if (!sharedState.downloadedHash) {
    log(`no downloaded hash yet, ignore switch to ${hash}`);
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
  options = { ...defaultClientOptions };
  clientType: 'Pushy' | 'Cresc' = 'Pushy';
  lastChecking?: number;
  lastRespJson?: Promise<CheckResult>;
  // Endpoint that most recently served a successful checkUpdate; telemetry
  // reuses it instead of re-running the fallback race.
  private lastWorkingEndpoint?: string;

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

    i18n.setLocale(
      options.locale ?? (this.clientType === 'Pushy' ? 'zh' : 'en'),
    );

    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      if (!options.appKey) {
        throw new UpdateError(
          i18n.t('error_appkey_required'),
          'APPKEY_REQUIRED',
        );
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
    code,
    data = {},
  }: {
    type: EventType;
    message?: string;
    code?: UpdateErrorCode;
    data?: Record<string, string | number>;
  }) => {
    log(`${type} ${code ? `[${code}] ` : ''}${message}`);
    // Fire-and-forget server telemetry; must not wait for the logger below.
    this.reportToServer({ type, message, code, data });
    if (this.options.logger === noop) {
      // Wait briefly for a logger to arrive via setOptions (e.g. the rollback
      // report fires in the constructor before the user configures one), but
      // give up after a bound instead of retaining the closure forever when
      // no logger is ever provided.
      await Promise.race([
        this.loggerPromise.promise,
        new Promise(resolve => setTimeout(resolve, 10 * 1000)),
      ]);
    }
    const { logger = noop, appKey } = this.options;
    const overridePackageVersion = this.options.overridePackageVersion;
    try {
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
          code,
          ...currentVersionInfo,
          ...data,
        },
      });
    } catch (e: any) {
      // A user-provided logger must never break the update flow, and report()
      // calls are fire-and-forget so a throw here would be an unhandled
      // rejection.
      log('logger error:', e?.message || e);
    }
  };
  /**
   * Best-effort lifecycle event reporting to the update server (aggregate
   * counts + sampled failure details power the version health view and the
   * rollback safety net server-side). Single POST to the last known working
   * endpoint, no retry, no fallback race; any failure is swallowed — telemetry
   * must never affect the update flow. Opt out with disableTelemetry.
   */
  private reportToServer = ({
    type,
    message = '',
    code,
    data = {},
  }: {
    type: EventType;
    message?: string;
    code?: UpdateErrorCode;
    data?: Record<string, string | number>;
  }) => {
    try {
      if (__DEV__ || this.options.disableTelemetry) {
        return;
      }
      const serverType = resolveServerEventType(type, code);
      if (!serverType) {
        return;
      }
      const { appKey } = this.options;
      const endpoint =
        this.lastWorkingEndpoint || this.options.server?.main?.[0];
      if (!appKey || !endpoint) {
        return;
      }
      const hash = resolveServerEventHash({ serverType, data, currentVersion });
      if (!hash) {
        return;
      }
      const send = (payloadType: typeof serverType, detail?: string) =>
        fetchWithTimeout(
          `${endpoint}/report/${appKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: payloadType,
              hash,
              packageVersion:
                this.options.overridePackageVersion || packageVersion,
              cInfo,
              detail: truncateDetail(detail),
            }),
          },
          DEFAULT_FETCH_TIMEOUT_MS,
        ).catch((e: any) => {
          log('telemetry report failed:', e?.message || e);
        });
      send(serverType, message || undefined);
      // A download that only succeeded after an incremental patch failed is
      // still a patch_fail signal server-side (diff quality), carried in
      // data.error alongside the downloadSuccess event.
      if (serverType === 'download_success' && data.error) {
        send('patch_fail', String(data.error));
      }
    } catch (e: any) {
      log('telemetry error:', e?.message || e);
    }
  };
  throwIfEnabled = (e: Error) => {
    if (this.options.throwError) {
      throw e;
    }
  };
  private errorListeners = new Set<UpdateErrorListener>();
  /**
   * Subscribe to every error the client reports (regardless of throwError).
   * Returns an unsubscribe function.
   */
  onError = (listener: UpdateErrorListener) => {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  };
  /**
   * Single exit point for errors: reports to the logger (with the stable
   * code) and notifies onError listeners. Whether to also throw stays with
   * the caller (throwIfEnabled or an unconditional rethrow).
   */
  private emitError = (
    error: UpdateError,
    type: EventType,
    {
      message = error.message,
      data,
    }: { message?: string; data?: Record<string, string | number> } = {},
  ) => {
    this.report({ type, message, code: error.code, data });
    for (const listener of this.errorListeners) {
      try {
        listener(error, type);
      } catch (e: any) {
        log('onError listener error:', e?.message || e);
      }
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
  runBeforeReload = async (context: BeforeReloadContext) => {
    const { beforeReload } = this.options;
    if (!beforeReload) {
      return true;
    }
    const shouldReload = await beforeReload(context);
    if (shouldReload === false) {
      log('beforeReload returned false, skipping reload');
      return false;
    }
    return true;
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
      throw new UpdateError(
        this.t('error_http_status', {
          status: resp.status,
          statusText: respText,
        }),
        'HTTP_STATUS',
        { extra: { status: resp.status } },
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
    this.lastWorkingEndpoint = endpoint;
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
    try {
      await Promise.resolve(PushyModule.markSuccess());
    } catch (e) {
      const err = toUpdateError(e, 'MARK_SUCCESS_FAILED');
      this.emitError(err, 'errorMarkSuccess');
      throw err;
    }
    sharedState.marked = true;
    this.report({ type: 'markSuccess' });
  };
  switchVersion = async (hash: string) => {
    if (!this.assertDebug('switchVersion()')) {
      return;
    }
    if (assertHash(hash) && !sharedState.applyingUpdate) {
      log(`switchVersion: ${hash}`);
      sharedState.applyingUpdate = true;
      try {
        if (!(await this.runBeforeReload({ type: 'switchVersion', hash }))) {
          sharedState.applyingUpdate = false;
          return;
        }
      } catch (e) {
        sharedState.applyingUpdate = false;
        const err = toUpdateError(e, 'SWITCH_VERSION_FAILED');
        this.emitError(err, 'errorSwitchVersion', {
          data: { newVersion: hash },
        });
        throw err;
      }
      try {
        return await PushyModule.reloadUpdate({ hash });
      } catch (e) {
        // reloadUpdate can reject (e.g. bundle missing); reset the flag so a
        // later retry is not permanently blocked by a stuck applyingUpdate.
        sharedState.applyingUpdate = false;
        const err = toUpdateError(e, 'SWITCH_VERSION_FAILED');
        this.emitError(err, 'errorSwitchVersion', {
          data: { newVersion: hash },
        });
        throw err;
      }
    }
  };

  switchVersionLater = async (hash: string) => {
    if (!this.assertDebug('switchVersionLater()')) {
      return;
    }
    if (assertHash(hash)) {
      log(`switchVersionLater: ${hash}`);
      try {
        return await PushyModule.setNeedUpdate({ hash });
      } catch (e) {
        const err = toUpdateError(e, 'SWITCH_VERSION_FAILED');
        this.emitError(err, 'errorSwitchVersion', {
          data: { newVersion: hash },
        });
        throw err;
      }
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
      // hdiffv2 能力特征:服务端据此决定是否下发 HBC 变换域 patch
      ...(hbcTransformVersion ? { hbcT: hbcTransformVersion } : {}),
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
        message: `${this.options.appKey}: ${stringifyBody}`,
      });
      const respJsonPromise = this.fetchCheckResult(fetchPayload);
      this.lastRespJson = respJsonPromise;
      const result: CheckResult = await respJsonPromise;

      log('checking result:', result);

      this.notifyAfterCheckUpdate({ status: 'completed', result });
      return result;
    } catch (e: any) {
      this.lastRespJson = previousRespJson;
      const err = toUpdateError(e, 'CHECK_FAILED');
      this.emitError(err, 'errorChecking', {
        message: err.message || this.t('error_cannot_connect_server'),
      });
      this.notifyAfterCheckUpdate({ status: 'error', error: err });
      this.throwIfEnabled(err);
      // Fall back to the previous successful response if we have one; otherwise
      // return undefined so callers can distinguish "check failed" from a real
      // empty result and avoid overwriting the last good updateInfo.
      return previousRespJson ? await previousRespJson : undefined;
    }
  };
  downloadUpdate = async (
    updateInfo: CheckResult,
    onDownloadProgress?: (data: ProgressData) => void,
  ) => {
    const { hash } = updateInfo;
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
    if (hash === currentVersion) {
      log(`current hash ${currentVersion}, ignored`);
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
    // Deduplicate concurrent downloads of the same hash regardless of whether a
    // progress callback was passed: all callers await the single in-flight
    // promise instead of triggering parallel native downloads.
    const existingTask = sharedState.downloadingTasks[hash];
    if (existingTask) {
      log(`download for hash ${hash} already in progress, reusing it`);
      return existingTask;
    }
    const task = this.performDownload(updateInfo, onDownloadProgress);
    sharedState.downloadingTasks[hash] = task;
    try {
      return await task;
    } finally {
      delete sharedState.downloadingTasks[hash];
    }
  };
  private performDownload = async (
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
    if (!hash) {
      return;
    }
    if (sharedState.progressHandlers[hash]) {
      return;
    }
    const patchStartTime = Date.now();
    if (onDownloadProgress) {
      const wrapProgress = (data: ProgressData) => {
        onDownloadProgress({
          ...data,
          progress: computeProgress(data.received, data.total),
        });
      };
      // @ts-expect-error harmony not in existing platforms
      if (Platform.OS === 'harmony') {
        sharedState.progressHandlers[hash] = DeviceEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          (progressData: ProgressData) => {
            if (progressData.hash === hash) {
              wrapProgress(progressData);
            }
          },
        );
      } else {
        sharedState.progressHandlers[hash] =
          pushyNativeEventEmitter.addListener(
            'RCTPushyDownloadProgress',
            (progressData: ProgressData) => {
              if (progressData.hash === hash) {
                wrapProgress(progressData);
              }
            },
          );
      }
    }
    const maxRetries = Math.max(0, Math.floor(this.options.maxRetries ?? 3));
    let succeeded = '';
    let lastError: any;
    const errorMessages: string[] = [];

    // Ordered download strategies, tried in sequence until one succeeds. Each
    // resolves its candidate URL lazily (testUrls) and runs the matching native
    // download. diff/pdiff are incremental and skipped entirely in dev; full is
    // attempted whenever a URL exists, and in dev with no URL it is treated as a
    // no-op success so the flow can proceed.
    type DownloadStrategy = {
      name: string;
      candidate: string | undefined;
      errorKey: 'error_diff_failed' | 'error_pdiff_failed' | 'error_full_patch_failed';
      skipInDev: boolean;
      devNoopWhenNoUrl: boolean;
      run: (url: string) => Promise<void>;
    };
    const strategies: DownloadStrategy[] = [
      {
        name: 'diff',
        candidate: diff,
        errorKey: 'error_diff_failed',
        skipInDev: true,
        devNoopWhenNoUrl: false,
        run: url =>
          PushyModule.downloadPatchFromPpk({
            updateUrl: url,
            hash,
            originHash: currentVersion,
          }),
      },
      {
        name: 'pdiff',
        candidate: pdiff,
        errorKey: 'error_pdiff_failed',
        skipInDev: true,
        devNoopWhenNoUrl: false,
        run: url =>
          PushyModule.downloadPatchFromPackage({
            updateUrl: url,
            hash,
          }),
      },
      {
        name: 'full',
        candidate: full,
        errorKey: 'error_full_patch_failed',
        skipInDev: false,
        devNoopWhenNoUrl: true,
        run: url =>
          PushyModule.downloadFullUpdate({
            updateUrl: url,
            hash,
          }),
      },
    ];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
        log(`retry attempt ${attempt}/${maxRetries}, waiting ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        errorMessages.length = 0;
        lastError = undefined;
        succeeded = '';
      }
      this.report({
        type: 'downloading',
        data: {
          newVersion: hash,
          attempt,
        },
      });
      for (const strategy of strategies) {
        if (succeeded) {
          break;
        }
        const url = await testUrls(joinUrls(paths, strategy.candidate));
        if (url && !(strategy.skipInDev && __DEV__)) {
          log(`downloading ${strategy.name}`);
          try {
            await strategy.run(url);
            succeeded = strategy.name;
          } catch (e: any) {
            const errorMessage = this.t(strategy.errorKey, {
              message: e.message,
            });
            errorMessages.push(errorMessage);
            lastError = Error(errorMessage);
            log(errorMessage);
          }
        } else if (!url && strategy.devNoopWhenNoUrl && __DEV__) {
          log(this.t('dev_incremental_update_disabled'));
          succeeded = strategy.name;
        }
      }
      if (succeeded) {
        break;
      }
    }
    if (sharedState.progressHandlers[hash]) {
      sharedState.progressHandlers[hash].remove();
      delete sharedState.progressHandlers[hash];
    }
    if (!succeeded) {
      const message = errorMessages.join(';');
      if (lastError) {
        const err = toUpdateError(lastError, 'DOWNLOAD_FAILED');
        this.emitError(err, 'errorUpdate', {
          message,
          data: { newVersion: hash },
        });
        throw err;
      }
      // No download URL was even attempted (e.g. dev without a full URL):
      // report for diagnostics but there is no error object to surface.
      this.report({
        type: 'errorUpdate',
        data: { newVersion: hash },
        message,
      });
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
      const err = new UpdateError(
        this.t('error_apk_pending_install'),
        'APK_INSTALL_PENDING',
      );
      this.emitError(err, 'errorInstallApk');
      this.throwIfEnabled(err);
      return;
    }
    if (Platform.Version <= 23) {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          const err = new UpdateError(
            this.t('error_storage_permission_rejected'),
            'STORAGE_PERMISSION_REJECTED',
          );
          this.emitError(err, 'rejectStoragePermission');
          this.throwIfEnabled(err);
          return;
        }
      } catch (e: any) {
        const err = toUpdateError(e, 'STORAGE_PERMISSION_ERROR');
        this.emitError(err, 'errorStoragePermission');
        this.throwIfEnabled(err);
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
    try {
      await PushyModule.downloadAndInstallApk({
        url,
        target: 'update.apk',
        hash: progressKey,
      });
      sharedState.apkStatus = 'downloaded';
    } catch (e) {
      sharedState.apkStatus = null;
      // Keep the native error (message/stack) instead of discarding it.
      const err = toUpdateError(e, 'APK_DOWNLOAD_FAILED');
      this.emitError(err, 'errorDownloadAndInstallApk', {
        message: err.message || this.t('error_apk_download_failed'),
      });
      this.throwIfEnabled(err);
    } finally {
      if (sharedState.progressHandlers[progressKey]) {
        sharedState.progressHandlers[progressKey].remove();
        delete sharedState.progressHandlers[progressKey];
      }
    }
  };
  restartApp = async () => {
    if (!(await this.runBeforeReload({ type: 'restartApp' }))) {
      return;
    }
    return PushyModule.restartApp();
  };
}

// for international users
export class Cresc extends Pushy {
  constructor(options: ClientOptions) {
    super(options, 'Cresc');
  }
}
