export interface VersionInfo {
  name: string;
  hash: string;
  description: string;
  metaInfo: string;
  config: {
    rollout: {
      [packageVersion: string]: number;
    };
    [key: string]: any;
  };
  pdiff?: string;
  diff?: string;
  full?: string;
}

interface RootResult {
  upToDate?: true;
  expired?: true;
  downloadUrl?: string;
  update?: true;
  paused?: 'app' | 'package';
  message?: string;
  paths?: string[];
}

export type CheckResult = RootResult &
  Partial<VersionInfo> & {
    expVersion?: VersionInfo;
  };

export interface ProgressData {
  hash: string;
  received: number;
  total: number;
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
  | 'downloadingApk'
  | 'rejectStoragePermission'
  | 'errorStoragePermission'
  | 'errorDownloadAndInstallApk'
  | 'errorInstallApk';

export interface EventData {
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
  dismissErrorAfter?: number;
  debug?: boolean;
  throwError?: boolean;
  beforeCheckUpdate?: () => Promise<boolean> | boolean;
  // 每次检查结束后都会触发，不影响原有检查流程
  afterCheckUpdate?: (state: UpdateCheckState) => Promise<void> | void;
  beforeDownloadUpdate?: (info: CheckResult) => Promise<boolean> | boolean;
  afterDownloadUpdate?: (info: CheckResult) => Promise<boolean> | boolean;
  onPackageExpired?: (info: CheckResult) => Promise<boolean> | boolean;
  overridePackageVersion?: string;
}

export interface UpdateTestPayload {
  type: '__rnPushyVersionHash' | string | null;
  data: any;
}
