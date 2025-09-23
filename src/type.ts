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
  main: string;
  backups?: string[];
  queryUrls?: string[];
}

export interface ClientOptions {
  appKey: string;
  server?: UpdateServerConfig;
  logger?: UpdateEventsLogger;
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
  beforeCheckUpdate?: () => Promise<boolean>;
  beforeDownloadUpdate?: (info: CheckResult) => Promise<boolean>;
  afterDownloadUpdate?: (info: CheckResult) => Promise<boolean>;
  onPackageExpired?: (info: CheckResult) => Promise<boolean>;
  overridePackageVersion?: string;
}

export interface UpdateTestPayload {
  type: '__rnPushyVersionHash' | string | null;
  data: any;
}
