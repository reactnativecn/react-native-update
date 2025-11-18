import { createContext, useContext } from 'react';
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
  currentHash: string;
  packageVersion: string;
  client?: Pushy | Cresc;
  progress?: ProgressData;
  updateInfo?: CheckResult;
  lastError?: Error;
}>(defaultContext);

export const useUpdate = __DEV__ ? () => {
  const context = useContext(UpdateContext);

  // 检查是否在 UpdateProvider 内部使用
  if (!context.client) {
    throw new Error(i18n.t('error_use_update_outside_provider'));
  }

  return context;
} : () => useContext(UpdateContext);

/** @deprecated Please use `useUpdate` instead */
export const usePushy = useUpdate;
