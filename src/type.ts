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

// 记录最近一次检查调用的状态，区分完成、跳过和出错。
export const UPDATE_CHECK_STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  ERROR: 'error',
} as const;

export interface UpdateCheckState {
  status: (typeof UPDATE_CHECK_STATUS)[keyof typeof UPDATE_CHECK_STATUS];
  result?: CheckResult;
  error?: Error;
}

export interface ProgressData {
  hash: string;
  received: number;
  total: number;
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
  beforeDownloadUpdate?: (info: CheckResult) => Promise<boolean> | boolean;
  afterDownloadUpdate?: (info: CheckResult) => Promise<boolean> | boolean;
  onPackageExpired?: (info: CheckResult) => Promise<boolean> | boolean;
  overridePackageVersion?: string;
}

export interface UpdateTestPayload {
  type: '__rnPushyVersionHash' | string | null;
  data: any;
}
