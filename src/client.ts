import {
  DeviceEventEmitter,
  type EmitterSubscription,
  Platform,
} from 'react-native';
import {
  buildTime,
  cInfo,
  currentVersion,
  currentVersionInfo,
  getBundleHash,
  isFirstTime,
  isRolledBack,
  PushyModule,
  packageVersion,
  pushyNativeEventEmitter,
  rolledBackVersion,
  setLocalHashInfo,
  supportedDiffVersion,
} from './core';
import { dedupeEndpoints, executeEndpointFallback } from './endpoint';
import {
  asUpdateErrorCode,
  toUpdateError,
  UpdateError,
  type UpdateErrorCode,
} from './error';
import i18n from './i18n';
import { PermissionsAndroid } from './permissions';
import {
  resolveServerEventHash,
  resolveServerEventType,
  truncateDetail,
} from './telemetry';
import type {
  BeforeReloadContext,
  CheckResult,
  ClientOptions,
  EventType,
  ProgressData,
  UpdateCheckState,
  UpdateServerConfig,
} from './type';
import {
  buildCheckRequestBody,
  type DownloadPlan,
  type DownloadStrategyType,
  decideDownload,
} from './updateFlowCore';
import {
  assertWeb,
  computeProgress,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  info,
  log,
  noop,
  promiseAny,
  testUrls,
  warn,
} from './utils';

/**
 * Receives every error the client reports, alongside the report event type.
 * The UpdateProvider subscribes to surface errors as lastError/Alert; user
 * code can subscribe too. Listeners run before any throwError rethrow.
 */
export type UpdateErrorListener = (
  error: UpdateError,
  eventType: EventType
) => void;

const SERVER_PRESETS = {
  // cn
  Pushy: {
    main: [
      'https://update.react-native.cn/api',
      'https://update.reactnative.cn/api',
    ],
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
  configuredEndpoints: string[]
) => {
  const configured = new Set(configuredEndpoints);
  return endpoints.filter((endpoint) => !configured.has(endpoint));
};

assertWeb();

const createDefaultClientOptions = (): ClientOptions => ({
  appKey: '',
  autoMarkSuccess: true,
  updateStrategy: __DEV__ ? 'alwaysAlert' : 'alertUpdateAndIgnoreError',
  checkStrategy: 'both',
  logger: noop,
  debug: false,
  throwError: false,
});

export const sharedState: {
  progressHandlers: Record<string, EmitterSubscription>;
  downloadingTasks: Record<string, Promise<string | undefined>>;
  // Progress callbacks per hash: concurrent downloadUpdate callers of the
  // same hash each register theirs here instead of the second one being
  // silently dropped by the in-flight dedup.
  progressCallbacks: Record<string, Set<(data: ProgressData) => void>>;
  downloadedHash?: string;
  toHash?: string;
  apkStatus: 'downloading' | 'downloaded' | null;
  marked: boolean;
  applyingUpdate: boolean;
} = {
  progressHandlers: {},
  downloadingTasks: {},
  progressCallbacks: {},
  downloadedHash: undefined,
  apkStatus: null,
  marked: false,
  applyingUpdate: false,
};

// The SDK is a process-level singleton: module-level sharedState, the global
// i18n locale and the native update state are all per-process, so a second
// client would silently share (and fight over) them. Constructing one is a
// hard integration error, except for the idempotent re-creation of the same
// client (same type + appKey), which dev fast-refresh triggers legitimately.
let activeClient: Pushy | undefined;

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
  options: ClientOptions = createDefaultClientOptions();
  clientType: 'Pushy' | 'Cresc' = 'Pushy';
  lastChecking?: number;
  lastRespJson?: Promise<CheckResult>;
  // Endpoint that most recently served a successful checkUpdate; telemetry
  // reuses it instead of re-running the fallback race.
  private lastWorkingEndpoint?: string;
  private syncedNativeConfigJson?: string;
  private pendingNativeConfigJson?: string;
  private nativeConfigSyncInFlight = false;

  version = cInfo.rnu;
  loggerPromise = (() => {
    let resolve: (value?: unknown) => void = () => {};
    const promise = new Promise((res) => {
      resolve = res;
    });
    return {
      promise,
      resolve,
    };
  })();

  constructor(options: ClientOptions, clientType?: 'Pushy' | 'Cresc') {
    this.clientType = clientType || 'Pushy';
    if (activeClient) {
      if (
        activeClient.clientType === this.clientType &&
        activeClient.options.appKey === options.appKey
      ) {
        // Same client re-created (e.g. fast refresh re-running the module
        // that builds it): apply the latest options and hand back the
        // existing instance instead of forking process-level state.
        activeClient.setOptions(options);
        // biome-ignore lint/correctness/noConstructorReturn: intentional singleton — identical re-creation must yield the existing instance
        return activeClient;
      }
      throw new UpdateError(
        i18n.t('error_client_singleton'),
        'SINGLETON_VIOLATION'
      );
    }
    this.options.server = cloneServerConfig(SERVER_PRESETS[this.clientType]);

    i18n.setLocale(
      options.locale ?? (this.clientType === 'Pushy' ? 'zh' : 'en')
    );

    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      if (!options.appKey) {
        throw new UpdateError(
          i18n.t('error_appkey_required'),
          'APPKEY_REQUIRED'
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
    activeClient = this;
  }

  /**
   * Bumped on every setOptions call. `options` is mutated in place (its
   * identity never changes), so reactive consumers (the UpdateProvider)
   * subscribe via onOptionsChange and re-read using this version as the
   * change signal.
   */
  optionsVersion = 0;
  private optionsListeners = new Set<() => void>();
  /**
   * Subscribe to option changes (any setOptions call). Returns an
   * unsubscribe function.
   */
  onOptionsChange = (listener: () => void) => {
    this.optionsListeners.add(listener);
    return () => {
      this.optionsListeners.delete(listener);
    };
  };

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
    this.optionsVersion++;
    for (const listener of this.optionsListeners) {
      try {
        listener();
      } catch (e: any) {
        log('onOptionsChange listener error:', e?.message || e);
      }
    }
    this.syncNativeConfig();
  };

  /** Build the subset of options used by the native cold-start check. */
  private getNativeConfig = (): Record<string, unknown> | undefined => {
    if (
      Platform.OS === 'web' ||
      typeof PushyModule.syncNativeConfig !== 'function'
    ) {
      // Older natives lack the method; on web PushyModule is a noop Proxy
      // and the feature-detect would false-positive.
      return undefined;
    }
    const { appKey, server, updateStrategy } = this.options;
    if (!appKey || !server?.main?.length) {
      return undefined;
    }
    return {
      appKey,
      packageVersion: this.getEffectivePackageVersion(),
      endpoints: server.main,
      queryUrls: server.queryUrls ?? [],
      // The native check may activate a downloaded version (next launch)
      // only under the silent strategies; alert-style strategies keep
      // activation with the JS side (§6/§10.1).
      afterDownload:
        updateStrategy === 'silentAndNow' || updateStrategy === 'silentAndLater'
          ? 'setNeedUpdate'
          : 'none',
      rnu: cInfo.rnu,
      rn: cInfo.rn,
    };
  };

  private getNativeConfigJson = (): string | undefined => {
    const config = this.getNativeConfig();
    return config ? JSON.stringify(config) : undefined;
  };

  private flushNativeConfig = () => {
    if (this.nativeConfigSyncInFlight) {
      return;
    }
    const configJson = this.pendingNativeConfigJson;
    this.pendingNativeConfigJson = undefined;
    if (!configJson || configJson === this.syncedNativeConfigJson) {
      return;
    }
    this.nativeConfigSyncInFlight = true;
    let syncResult: Promise<void>;
    try {
      syncResult = Promise.resolve(PushyModule.syncNativeConfig(configJson));
    } catch (e: any) {
      this.nativeConfigSyncInFlight = false;
      log('syncNativeConfig failed:', e?.message || e);
      return;
    }
    syncResult
      .then(() => {
        this.syncedNativeConfigJson = configJson;
      })
      .catch((e: any) => {
        log('syncNativeConfig failed:', e?.message || e);
      })
      .finally(() => {
        this.nativeConfigSyncInFlight = false;
        this.flushNativeConfig();
      });
  };

  private syncNativeConfig = () => {
    const configJson = this.getNativeConfigJson();
    if (!configJson) {
      return;
    }
    // Always record the latest desired value, even when it matches the last
    // completed write. Example: A synced -> B in flight -> options revert to
    // A. Comparing only with synced(A) would drop the revert and leave native
    // storage at B after that in-flight write completes.
    // Coalesce rapid setOptions calls, but serialize bridge writes so an older
    // completion can never overwrite the newest desired configuration.
    this.pendingNativeConfigJson = configJson;
    this.flushNativeConfig();
  };

  /** Package version used by every server-side update decision. */
  getEffectivePackageVersion = () =>
    this.options.overridePackageVersion || packageVersion;

  private jsonValuesEqual = (left: unknown, right: unknown): boolean => {
    const compare = (a: unknown, b: unknown): boolean => {
      if (a === b) {
        return true;
      }
      if (Array.isArray(a) || Array.isArray(b)) {
        return (
          Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((value, index) => compare(value, b[index]))
        );
      }
      if (
        a === null ||
        b === null ||
        typeof a !== 'object' ||
        typeof b !== 'object'
      ) {
        return false;
      }
      const leftObject = a as Record<string, unknown>;
      const rightObject = b as Record<string, unknown>;
      // Match JSON.stringify semantics for request extras: object properties
      // whose value is undefined are omitted from the wire fingerprint.
      const leftKeys = Object.keys(leftObject)
        .filter((key) => leftObject[key] !== undefined)
        .sort();
      const rightKeys = Object.keys(rightObject)
        .filter((key) => rightObject[key] !== undefined)
        .sort();
      return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
          (key, index) =>
            key === rightKeys[index] &&
            compare(leftObject[key], rightObject[key])
        )
      );
    };

    return compare(left, right);
  };

  private providerMounted = false;
  /**
   * Called by UpdateProvider on mount. A second concurrently mounted
   * provider is the same integration error as a second client — fail hard
   * instead of double-subscribing app-state listeners and update checks.
   * Returns the release function used on unmount.
   */
  claimProviderMount = () => {
    if (this.providerMounted) {
      throw new UpdateError(
        this.t('error_provider_singleton'),
        'SINGLETON_VIOLATION'
      );
    }
    this.providerMounted = true;
    return () => {
      this.providerMounted = false;
    };
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
        new Promise((resolve) => setTimeout(resolve, 10 * 1000)),
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
              packageVersion: this.getEffectivePackageVersion(),
              cInfo,
              detail: truncateDetail(detail),
            }),
          },
          DEFAULT_FETCH_TIMEOUT_MS
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
  private emittedErrors = new WeakSet<Error>();
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
   * Whether this exact error object already went through emitError (and was
   * therefore delivered to onError subscribers). Lets UI layers decide if a
   * caught error still needs surfacing — checking `e.code` is not enough,
   * since axios/system errors carry their own code without ever entering the
   * pipeline.
   */
  wasEmitted = (e: unknown): boolean =>
    e instanceof Error && this.emittedErrors.has(e);
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
    }: { message?: string; data?: Record<string, string | number> } = {}
  ) => {
    this.emittedErrors.add(error);
    this.report({
      type,
      message,
      code: error.code,
      // Structured context from the error (e.g. HTTP status) reaches the
      // logger; explicit data wins on key conflicts.
      data: error.extra ? { ...error.extra, ...data } : data,
    });
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
        server.queryUrls.map((queryUrl) =>
          fetchWithTimeout(queryUrl, {}, DEFAULT_FETCH_TIMEOUT_MS)
        )
      );
      const remoteEndpoints = await resp.json();
      log('fetch endpoints:', remoteEndpoints);
      if (Array.isArray(remoteEndpoints)) {
        return excludeConfiguredEndpoints(
          dedupeEndpoints(
            remoteEndpoints.filter(
              (endpoint): endpoint is string => typeof endpoint === 'string'
            )
          ),
          this.getConfiguredCheckEndpoints()
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
    signal?: AbortSignal
  ) => {
    const resp = await fetchWithTimeout(
      this.getCheckUrl(endpoint),
      signal ? { ...fetchPayload, signal } : fetchPayload,
      DEFAULT_FETCH_TIMEOUT_MS
    );

    if (!resp.ok) {
      const respText = await resp.text();
      throw new UpdateError(
        this.t('error_http_status', {
          status: resp.status,
          statusText: respText,
        }),
        'HTTP_STATUS',
        { extra: { status: resp.status } }
      );
    }

    return (await resp.json()) as CheckResult;
  };
  fetchCheckResult = async (fetchPayload: Parameters<typeof fetch>[1]) => {
    const { endpoint, value } = await executeEndpointFallback<CheckResult>({
      configuredEndpoints: this.getConfiguredCheckEndpoints(),
      getRemoteEndpoints: this.getRemoteEndpoints,
      tryEndpoint: async (currentEndpoint, signal) => {
        try {
          return await this.requestCheckResult(
            currentEndpoint,
            fetchPayload,
            signal
          );
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
  /**
   * Reuse the native cold-start check's cached response when fresh
   * (NATIVE_CHECKUPDATE_DESIGN §10.3) instead of re-checking. Returns
   * undefined whenever the cache is absent, stale, or unreadable — any
   * failure falls through to a normal network check.
   */
  private readNativeCheckCache = async (
    requestBody: Record<string, any>
  ): Promise<CheckResult | undefined> => {
    try {
      if (__DEV__ || typeof PushyModule.getNativeCheckCache !== 'function') {
        return undefined;
      }
      const raw = await Promise.resolve(PushyModule.getNativeCheckCache());
      if (!raw || typeof raw !== 'string') {
        return undefined;
      }
      const entry = JSON.parse(raw);
      const config = this.getNativeConfig();
      const cachedRequest =
        typeof entry?.request === 'string'
          ? JSON.parse(entry.request)
          : undefined;
      const cachedConfig =
        typeof entry?.config === 'string'
          ? JSON.parse(entry.config)
          : undefined;
      if (
        typeof entry?.ts !== 'number' ||
        typeof entry?.body !== 'string' ||
        !this.jsonValuesEqual(cachedRequest, requestBody) ||
        !config ||
        !this.jsonValuesEqual(cachedConfig, config)
      ) {
        return undefined;
      }
      const ageSeconds = Date.now() / 1000 - entry.ts;
      if (ageSeconds < 0 || ageSeconds > 120) {
        return undefined;
      }
      const result = JSON.parse(entry.body);
      if (!result || typeof result !== 'object') {
        return undefined;
      }
      log('reusing native check response cache');
      return result as CheckResult;
    } catch {
      return undefined;
    }
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
        // A throw from the user's beforeReload hook is business-code failure,
        // not an update-pipeline one: give it a distinct code so telemetry
        // excludes it from the server-side patch-health stats.
        const err = toUpdateError(e, 'USER_HOOK_ERROR');
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
    // 内容寻址的二进制身份,服务端据此精确判定 pdiff 适用性(取代 buildTime
    // 启发式)。同步读 core 里已预取的值:还没算完就省略字段(服务端回退
    // buildTime 启发式),下一次检查自然带上——绝不为它 await、拖慢或复杂化
    // 检查流程。
    const bundleHash = __DEV__ ? '' : getBundleHash();
    const now = Date.now();
    if (
      this.lastRespJson &&
      this.lastChecking &&
      now - this.lastChecking < 1000 * 5
    ) {
      try {
        const result = await this.lastRespJson;
        this.notifyAfterCheckUpdate({ status: 'completed', result });
        return result;
      } catch (e: any) {
        // The shared in-flight check failed. Its initiating call reports it
        // through emitError/throw; this call must still honor its own
        // contract — afterCheckUpdate always fires and throwError applies —
        // without double-reporting the same error.
        const err = toUpdateError(e, 'CHECK_FAILED');
        this.notifyAfterCheckUpdate({ status: 'error', error: err });
        this.throwIfEnabled(err);
        return undefined;
      }
    }
    this.lastChecking = now;
    const fetchBody = buildCheckRequestBody({
      packageVersion: this.getEffectivePackageVersion(),
      currentVersion,
      buildTime,
      cInfo,
      supportedDiffVersion,
      bundleHash,
      isDev: __DEV__,
      extra,
    });
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
      // The native cold-start check may have a fresh response on disk
      // (§10.3); reuse it instead of re-checking. The read happens INSIDE
      // the promise so no await lands between the dedup window above and the
      // lastRespJson assignment below (the JS2-1 double-send lesson).
      const respJsonPromise = (async (): Promise<CheckResult> => {
        // While bundleHash prefetch is still pending, the JS request omits
        // that key whereas the native request always includes its synchronously
        // computed value. That narrow first-launch window intentionally misses
        // the cache rather than delaying checkUpdate for hashing.
        const cached = await this.readNativeCheckCache(fetchBody);
        return cached ?? (await this.fetchCheckResult(fetchPayload));
      })();
      this.lastRespJson = respJsonPromise;
      const result: CheckResult = await respJsonPromise;

      log('checking result:', result);

      if (result?.bundleStatus === 'unknownBundle') {
        // 服务端判定当前二进制内嵌 bundle 未注册,增量已被降级为全量。只面向
        // 开发者(日志 + 遥测,控制台聚合是主渠道);终端用户无感知。
        warn(this.t('warn_unknown_bundle'));
        this.report({
          type: 'bundleMismatch',
          data: bundleHash ? { bundleHash } : {},
        });
      }

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
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    if (
      this.options.beforeDownloadUpdate &&
      (await this.options.beforeDownloadUpdate(updateInfo)) === false
    ) {
      log('beforeDownloadUpdate returned false, skipping download');
      return;
    }
    const decision = decideDownload(
      updateInfo,
      { currentVersion, rolledBackVersion },
      __DEV__
    );
    if (decision.action === 'none') {
      if (decision.reason === 'alreadyCurrent') {
        log(`current hash ${currentVersion}, ignored`);
      } else if (decision.reason === 'rolledBack') {
        log(`rolledback hash ${rolledBackVersion}, ignored`);
      } else if (decision.reason === 'noArtifact') {
        // A server response that advertises an update but provides no usable
        // artifact is a bad release signal, not an ordinary no-update result.
        // Keep the user flow silent, but restore the diagnostic/telemetry event
        // that the old empty-attempt path emitted.
        this.report({
          type: 'errorUpdate',
          data: { newVersion: updateInfo.hash || '' },
          message: 'update response contains no downloadable artifact',
        });
      }
      return;
    }
    const { hash } = decision;
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
      // The second caller's progress callback must still fire.
      if (onDownloadProgress) {
        sharedState.progressCallbacks[hash]?.add(onDownloadProgress);
      }
      return existingTask;
    }
    const task = this.performDownload(updateInfo, decision, onDownloadProgress);
    sharedState.downloadingTasks[hash] = task;
    try {
      return await task;
    } finally {
      delete sharedState.downloadingTasks[hash];
    }
  };
  private performDownload = async (
    updateInfo: CheckResult,
    plan: DownloadPlan,
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    const { name, description = '', metaInfo } = updateInfo;
    const { hash, attempts, devNoop } = plan;
    const patchStartTime = Date.now();
    // One native listener per hash dispatching to a callback set, so
    // concurrent callers deduped onto this task can each observe progress
    // (they register via downloadUpdate).
    const progressCallbacks = new Set<(data: ProgressData) => void>();
    if (onDownloadProgress) {
      progressCallbacks.add(onDownloadProgress);
    }
    sharedState.progressCallbacks[hash] = progressCallbacks;
    const dispatchProgress = (data: ProgressData) => {
      const callbacks = sharedState.progressCallbacks[hash];
      if (!callbacks || callbacks.size === 0) {
        return;
      }
      const payload = {
        ...data,
        progress: computeProgress(data.received, data.total),
      };
      callbacks.forEach((callback) => {
        callback(payload);
      });
    };
    const onNativeProgress = (progressData: ProgressData) => {
      if (progressData.hash === hash) {
        dispatchProgress(progressData);
      }
    };
    // @ts-expect-error harmony not in existing platforms
    if (Platform.OS === 'harmony') {
      sharedState.progressHandlers[hash] = DeviceEventEmitter.addListener(
        'RCTPushyDownloadProgress',
        onNativeProgress
      );
    } else {
      sharedState.progressHandlers[hash] = pushyNativeEventEmitter.addListener(
        'RCTPushyDownloadProgress',
        onNativeProgress
      );
    }
    const maxRetries = Math.max(0, Math.floor(this.options.maxRetries ?? 3));
    let succeeded = '';
    let lastError: any;
    const errorMessages: string[] = [];

    // The ordered attempts come from decideDownload (the pure decision layer);
    // this side only executes them: probe candidate URLs, run the matching
    // native download, fall through to the next attempt on failure.
    const runners: Record<
      DownloadStrategyType,
      (url: string) => Promise<void>
    > = {
      diff: (url) =>
        PushyModule.downloadPatchFromPpk({
          updateUrl: url,
          hash,
          originHash: currentVersion,
        }),
      pdiff: (url) =>
        PushyModule.downloadPatchFromPackage({
          updateUrl: url,
          hash,
        }),
      full: (url) =>
        PushyModule.downloadFullUpdate({
          updateUrl: url,
          hash,
        }),
    };
    const errorKeys = {
      diff: 'error_diff_failed',
      pdiff: 'error_pdiff_failed',
      full: 'error_full_patch_failed',
    } as const;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
        log(`retry attempt ${attempt}/${maxRetries}, waiting ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
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
      if (devNoop) {
        log(this.t('dev_incremental_update_disabled'));
        succeeded = 'full';
      }
      for (const { type, urls } of attempts) {
        if (succeeded) {
          break;
        }
        const url = await testUrls(urls);
        if (!url) {
          continue;
        }
        log(`downloading ${type}`);
        try {
          await runners[type](url);
          succeeded = type;
        } catch (e: any) {
          const errorMessage = this.t(errorKeys[type], {
            message: e.message,
          });
          errorMessages.push(errorMessage);
          // Keep the i18n message for display, but preserve the native
          // rejection's stable code (e.g. PATCH_FAILED vs DOWNLOAD_FAILED —
          // telemetry classifies on it) and the original error as cause.
          lastError = new UpdateError(
            errorMessage,
            asUpdateErrorCode(e?.code) ?? 'DOWNLOAD_FAILED',
            { cause: e }
          );
          log(errorMessage);
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
    delete sharedState.progressCallbacks[hash];
    if (succeeded && errorMessages.length > 0) {
      // An earlier strategy failed and a later one rescued the download
      // (e.g. pdiff copiesCrc mismatch on a rebuilt binary → full). Surface
      // the degradation: it is invisible to the end user but tells the
      // platform that incremental delivery is failing for this binary.
      this.report({
        type: 'downloadFallback',
        // UpdateError.code already carries the classified native rejection
        // code (PATCH_FAILED vs DOWNLOAD_FAILED).
        code: lastError?.code,
        data: {
          newVersion: hash,
          succeeded,
        },
        message: errorMessages.join(';'),
      });
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
    onDownloadProgress?: (data: ProgressData) => void
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
        'APK_INSTALL_PENDING'
      );
      this.emitError(err, 'errorInstallApk');
      this.throwIfEnabled(err);
      return;
    }
    if (Platform.Version <= 23) {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          const err = new UpdateError(
            this.t('error_storage_permission_rejected'),
            'STORAGE_PERMISSION_REJECTED'
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
          }
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
    try {
      if (!(await this.runBeforeReload({ type: 'restartApp' }))) {
        return;
      }
    } catch (e) {
      const err = toUpdateError(e, 'USER_HOOK_ERROR');
      this.emitError(err, 'errorRestart');
      throw err;
    }
    try {
      return await PushyModule.restartApp();
    } catch (e) {
      const err = toUpdateError(e, 'RESTART_FAILED');
      this.emitError(err, 'errorRestart');
      throw err;
    }
  };
  /**
   * Reset to the bundle packaged in the binary: wipes every downloaded update
   * and the whole update state on the native side, so the app loads the
   * built-in bundle on the next launch (or immediately with
   * `{ restart: true }`). The client uuid is preserved.
   *
   * Returns whether the reset actually happened. Like the other update-flow
   * APIs it never throws by default — failures land in lastError/onError with
   * code RESET_FAILED — but the boolean must not be ignored: a false means the
   * app is still running the hot-updated bundle. Set `throwError` to throw.
   */
  resetToPackagedBundle = async (options?: {
    restart?: boolean;
  }): Promise<boolean> => {
    if (!assertWeb()) {
      // On web PushyModule is a Proxy of noops, so the feature-detect below
      // would report a false success.
      return false;
    }
    if (typeof PushyModule.resetToPackagedBundle !== 'function') {
      // The JS layer can arrive via hot update onto an older binary whose
      // native module predates this method.
      const err = new UpdateError(
        this.t('error_reset_not_supported'),
        'RESET_FAILED'
      );
      this.emitError(err, 'errorReset');
      this.throwIfEnabled(err);
      return false;
    }
    try {
      await PushyModule.resetToPackagedBundle();
    } catch (e) {
      const err = toUpdateError(e, 'RESET_FAILED');
      this.emitError(err, 'errorReset');
      this.throwIfEnabled(err);
      return false;
    }
    // The downloaded versions are gone; drop JS bookkeeping referring to them
    // so a stale downloadedHash cannot be switched to.
    sharedState.downloadedHash = undefined;
    sharedState.toHash = undefined;
    sharedState.marked = false;
    this.report({ type: 'reset' });
    if (options?.restart) {
      try {
        await this.restartApp();
      } catch (e: any) {
        // The reset itself succeeded and the restart failure was already
        // reported through the pipeline; the boolean must still say "state
        // is reset".
        log('restart after reset failed:', e?.message || e);
      }
    }
    return true;
  };
}

// for international users
export class Cresc extends Pushy {
  constructor(options: ClientOptions) {
    super(options, 'Cresc');
  }
}
