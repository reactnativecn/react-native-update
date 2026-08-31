import type { UpdateErrorCode } from './error';

export interface VersionInfo {
  name: string;
  hash: string;
  description: string;
  metaInfo: string;
  config: {
    rollout: {
      [packageVersion: string]: number;
    };
    /**
     * Server-set per-version override: the native cold-start check activates
     * this version for the next launch regardless of the client's
     * updateStrategy (the brick-rescue directive). Native-only — the JS
     * interactive flow ignores it. The device-local rolledBack guard still
     * wins, and first_time crash protection still applies.
     */
    forceBoot?: boolean;
    [key: string]: any;
  };
  pdiff?: string;
  diff?: string;
  full?: string;
}

interface RootResult {
  upToDate?: boolean;
  expired?: boolean;
  downloadUrl?: string;
  update?: boolean;
  paused?: 'app' | 'package';
  message?: string;
  paths?: string[];
  /**
   * Server verdict on the reported bundleHash: 'matched' — the installed
   * binary is registered; 'rebuiltSameJs' — repackaged binary with identical
   * JS (no upload needed); 'unknownBundle' — unregistered binary, incremental
   * updates degraded to full downloads until the package is uploaded.
   */
  bundleStatus?: 'matched' | 'rebuiltSameJs' | 'unknownBundle';
}

export type UpToDateCheckResult = RootResult & {
  upToDate: true;
};

export type UpdateAvailableCheckResult = RootResult &
  Partial<VersionInfo> & {
    update: true;
    expVersion?: VersionInfo;
  };

export type ExpiredCheckResult = RootResult & {
  expired: true;
  downloadUrl: string;
};

export type CheckResult = RootResult &
  Partial<VersionInfo> & {
    expVersion?: VersionInfo;
  };

export interface ProgressData {
  hash: string;
  received: number;
  total: number;
  /** Download progress percentage (0-100), computed from received / total and clamped to range. Only populated in downloadUpdate callbacks. */
  progress?: number;
}

// 用于描述一次检查结束后的最终状态，便于业务侧感知成功、跳过或失败
export interface UpdateCheckState {
  status: 'completed' | 'skipped' | 'error';
  result?: CheckResult;
  error?: Error;
}

export type EventType =
  | 'rollback'
  | 'errorChecking'
  | 'checking'
  | 'downloading'
  | 'downloadSuccess'
  | 'errorUpdate'
  | 'markSuccess'
  | 'errorMarkSuccess'
  // 救砖回执:被 forceBoot / 崩溃时刻救援送进来的版本活到了 markSuccess。
  // 原生在下载提交时往 hashInfo 写对应标记(§10.7 / §11.3),JS 在
  // markSuccess 后各补报一条;老服务端对未知 type 400,report 本就是
  // best-effort 静默丢弃,无害。
  | 'forceBootRescue'
  | 'crashRescue'
  | 'reset'
  | 'errorReset'
  // Server reported bundleStatus: unknownBundle — the installed binary is not
  // registered on the update platform (developer-facing only, local logger;
  // not a server telemetry event).
  | 'bundleMismatch'
  // An incremental strategy (diff/pdiff) failed but a later strategy saved the
  // download. Carries which strategy failed and why — the signal that watches
  // pdiff copiesCrc verification failures (BUNDLEHASH_MIGRATION §4.2.1) in
  // the field.
  | 'downloadFallback'
  | 'errorRestart'
  | 'errorSwitchVersion'
  | 'downloadingApk'
  | 'rejectStoragePermission'
  | 'errorStoragePermission'
  | 'errorDownloadAndInstallApk'
  | 'errorInstallApk';

export interface EventData {
  /** Stable machine-readable error code; present on error events */
  code?: UpdateErrorCode;
  currentVersion: string;
  cInfo: {
    rnu: string;
    rn: string;
    os: string;
    uuid: string;
  };
  packageVersion: string;
  buildTime: string;
  message?: string;
  rolledBackVersion?: string;
  newVersion?: string;
  name?: string;
  description?: string;
  metaInfo?: string;
  [key: string]: any;
}

export type UpdateEventsLogger = ({
  type,
  data,
}: {
  type: EventType;
  data: EventData;
}) => void;

export interface UpdateServerConfig {
  main: string[];
  queryUrls?: string[];
}

export interface BeforeReloadContext {
  type: 'switchVersion' | 'restartApp';
  hash?: string;
}

export interface ClientOptions {
  appKey: string;
  server?: UpdateServerConfig;
  logger?: UpdateEventsLogger;
  locale?: 'zh' | 'en';
  updateStrategy?:
    | 'alwaysAlert'
    | 'alertUpdateAndIgnoreError'
    | 'silentAndNow'
    | 'silentAndLater'
    | null;
  checkStrategy?: 'onAppStart' | 'onAppResume' | 'both' | null;
  autoMarkSuccess?: boolean;
  /**
   * Delay before the Provider marks the running update as successful when
   * `autoMarkSuccess` is on. Default 1000ms. Apps whose critical modules load
   * after the first frame (navigation, remote config) should raise it — a
   * version that crashes 3s after mount would otherwise already be marked
   * good and never rolled back. For full control use `autoMarkSuccess: false`
   * and call `markSuccess()` once the app is really ready.
   */
  autoMarkSuccessDelayMs?: number;
  /**
   * Consulted when the auto-mark timer fires: return false (or throw) to
   * skip marking this launch — the next launch's crash protection then still
   * applies. Call `markSuccess()` yourself later once the app is healthy.
   */
  healthCheck?: () => boolean | Promise<boolean>;
  /**
   * Whether the Provider honours test-channel payloads (`parseTestQrCode`,
   * `__rnPushyVersionHash` deep links / QR codes) that target a specific
   * version hash. Default true. Set to false in production builds that must
   * not let a scanned code pull an arbitrary published version.
   */
  testChannel?: boolean;
  dismissErrorAfter?: number;
  debug?: boolean;
  throwError?: boolean;
  beforeCheckUpdate?: () => Promise<boolean> | boolean;
  // 每次检查结束后都会触发，不影响原有检查流程
  afterCheckUpdate?: (state: UpdateCheckState) => Promise<void> | void;
  beforeDownloadUpdate?: (info: CheckResult) => Promise<boolean> | boolean;
  afterDownloadUpdate?: (info: CheckResult) => Promise<boolean> | boolean;
  beforeReload?: (
    context: BeforeReloadContext
  ) => Promise<boolean | undefined> | boolean | undefined;
  onPackageExpired?: (info: CheckResult) => Promise<boolean> | boolean;
  overridePackageVersion?: string;
  /** Maximum number of retry attempts for failed downloads (default: 3) */
  maxRetries?: number;
  /**
   * Disable reporting update lifecycle events (download/patch failures,
   * rollback, mark success) to the update server. These aggregate stats power
   * the version health view in the console. Default: false (enabled).
   */
  disableTelemetry?: boolean;
  /**
   * Disable automatic and manual JavaScript exception reporting. Reporting is
   * enabled by default and chains React Native's existing global ErrorUtils
   * handler. Set this to true for an explicit opt-out; update lifecycle
   * telemetry remains controlled separately by `disableTelemetry`.
   */
  disableErrorReporting?: boolean;
  /**
   * Disable the native cold-start update check: the background check that runs
   * a few seconds after every launch, independent of JS
   * (NATIVE_CHECKUPDATE_DESIGN §10). Default: false (enabled).
   *
   * That check is what rescues a device bricked by a bad update — its JS never
   * runs, so nothing else can pull the fix. Turning it off gives up that
   * recovery path (and the response cache the JS check reuses) in exchange for
   * one fewer background request per cold start; choose it only when the extra
   * request is itself the problem (traffic/battery budgets, privacy manifests,
   * consent-gated networking).
   *
   * Orthogonal to `checkStrategy`, which governs activation authority rather
   * than whether the check runs: with `checkStrategy: null` the native check
   * still downloads but never activates on its own — only the server's
   * per-version forceBoot directive may.
   */
  disableNativeCheck?: boolean;
}

export interface UpdateTestPayload {
  type: '__rnPushyVersionHash' | string | null;
  data: any;
}
