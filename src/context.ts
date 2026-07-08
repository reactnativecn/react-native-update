import { createContext, useContext, useMemo } from 'react';
import { CheckResult, ProgressData } from './type';
import { Pushy, Cresc } from './client';
import i18n from './i18n';

const noop = () => {};
const asyncNoop = () => Promise.resolve();

export const defaultContext = {
  checkUpdate: asyncNoop,
  switchVersion: asyncNoop,
  switchVersionLater: asyncNoop,
  markSuccess: noop,
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

export const UpdateContext = createContext<{
  checkUpdate: () => Promise<void | CheckResult>;
  switchVersion: () => Promise<void>;
  switchVersionLater: () => Promise<void>;
  markSuccess: () => void;
  dismissError: () => void;
  downloadUpdate: () => Promise<boolean | void>;
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
  parseTestQrCode: (code: string) => boolean;
  restartApp: () => Promise<void>;
  resetToPackagedBundle: (options?: { restart?: boolean }) => Promise<void>;
  currentHash: string;
  packageVersion: string;
  client?: Pushy | Cresc;
  updateInfo?: CheckResult;
  lastError?: Error;
}>(defaultContext);

// Download progress ticks at high frequency, so it lives in its own context;
// otherwise every tick would re-render all useUpdate() consumers even when
// they never read progress.
export const ProgressContext = createContext<ProgressData | undefined>(
  undefined,
);

/**
 * Subscribe to download progress only. Components that render a progress bar
 * should prefer this over useUpdate() so the rest of the tree is not
 * re-rendered on every progress event.
 */
export const useUpdateProgress = () => useContext(ProgressContext);

export const useUpdate = () => {
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
