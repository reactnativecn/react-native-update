import { createContext, useContext, useMemo } from 'react';
import type { Cresc, Pushy } from './client';
import i18n from './i18n';
import type { CheckResult, ProgressData, UpdateTestPayload } from './type';

const noop = () => {};
const asyncNoop = () => Promise.resolve(undefined);

/**
 * What UpdateProvider puts into UpdateContext (and useUpdate() returns, plus
 * `progress`). The signatures mirror the provider's callbacks: the `info`
 * parameters default to the last check result, `checkUpdate` accepts request
 * extras, and the mutations resolve once the client is done.
 */
export interface UpdateContextValue {
  checkUpdate: (params?: {
    extra?: Partial<{ toHash: string }>;
  }) => Promise<undefined | CheckResult>;
  /** Resolves true once the native reload was requested; false when skipped. */
  switchVersion: (info?: CheckResult) => Promise<boolean | undefined>;
  switchVersionLater: (info?: CheckResult) => Promise<void>;
  markSuccess: () => Promise<void>;
  dismissError: () => void;
  downloadUpdate: (info?: CheckResult) => Promise<boolean | undefined>;
  downloadAndInstallApk: (url: string) => Promise<void>;
  // @deprecated use currentVersionInfo instead
  getCurrentVersionInfo: () => Promise<{
    name?: string;
    description?: string;
    metaInfo?: string;
  }>;
  currentVersionInfo: {
    name?: string;
    description?: string;
    metaInfo?: string;
  } | null;
  parseTestQrCode: (code: string | UpdateTestPayload) => boolean;
  restartApp: () => Promise<void>;
  resetToPackagedBundle: (options?: {
    restart?: boolean;
  }) => Promise<boolean | undefined>;
  currentHash: string;
  packageVersion: string;
  client?: Pushy | Cresc;
  updateInfo?: CheckResult;
  lastError?: Error;
}

export const defaultContext: UpdateContextValue = {
  checkUpdate: asyncNoop,
  switchVersion: asyncNoop,
  switchVersionLater: asyncNoop,
  markSuccess: asyncNoop,
  dismissError: noop,
  downloadUpdate: asyncNoop,
  downloadAndInstallApk: asyncNoop,
  restartApp: asyncNoop,
  resetToPackagedBundle: asyncNoop,
  getCurrentVersionInfo: () => Promise.resolve({}),
  parseTestQrCode: () => false,
  currentHash: '',
  packageVersion: '',
  currentVersionInfo: {},
};

export const UpdateContext = createContext<UpdateContextValue>(defaultContext);

// Download progress ticks at high frequency, so it lives in its own context;
// otherwise every tick would re-render all useUpdate() consumers even when
// they never read progress.
export const ProgressContext = createContext<ProgressData | undefined>(
  undefined
);

/**
 * Subscribe to download progress only. Components that render a progress bar
 * should prefer this over useUpdate() so the rest of the tree is not
 * re-rendered on every progress event.
 */
export const useUpdateProgress = () => useContext(ProgressContext);

export const useUpdate = (): UpdateContextValue & {
  progress?: ProgressData;
} => {
  const context = useContext(UpdateContext);
  const progress = useContext(ProgressContext);

  if (__DEV__ && !context.client) {
    // 检查是否在 UpdateProvider 内部使用
    throw new Error(i18n.t('error_use_update_outside_provider'));
  }

  return useMemo(() => ({ ...context, progress }), [context, progress]);
};

/** @deprecated Please use `useUpdate` instead */
export const usePushy = useUpdate;
