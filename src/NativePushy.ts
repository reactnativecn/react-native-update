import { type TurboModule, TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  getConstants: () => {
    downloadRootDir: string;
    packageVersion: string;
    currentVersion: string;
    isFirstTime: boolean;
    rolledBackVersion: string;
    buildTime: string;
    uuid: string;
    isUsingBundleUrl: boolean;
    currentVersionInfo: string;
    supportedDiffVersion: number;
  };
  setLocalHashInfo(hash: string, info: string): Promise<void>;
  getLocalHashInfo(hash: string): Promise<string>;
  setUuid(uuid: string): Promise<void>;
  /**
   * Persist the config subset the native cold-start update check consumes
   * (appKey, endpoints, afterDownload policy; NATIVE_CHECKUPDATE_DESIGN
   * §10.1). Stored as a raw JSON string, parsed natively on read. JS is the
   * single config source — a native side without persisted config silently
   * skips its check, which doubles as the feature's rollout gate.
   */
  syncNativeConfig(config: string): Promise<void>;
  /**
   * Raw response cached by the native cold-start check
   * ('{"ts":<epoch seconds>,"body":<raw checkUpdate response>}'), so the JS
   * side can reuse a fresh result instead of re-checking (§10.3). Resolves to
   * an empty string when absent; never rejects.
   */
  getNativeCheckCache(): Promise<string>;
  reloadUpdate(options: { hash: string }): Promise<void>;
  restartApp(): Promise<void>;
  setNeedUpdate(options: { hash: string }): Promise<void>;
  markSuccess(): Promise<void>;
  /**
   * sha256 of the JS bundle embedded in the binary (the pdiff source), lazily
   * computed and cached natively. Resolves to an empty string when unknown
   * (debug build, no embedded bundle, hash failure) — never rejects.
   */
  getBundleHash(): Promise<string>;
  resetToPackagedBundle(): Promise<void>;
  downloadPatchFromPpk(options: {
    updateUrl: string;
    hash: string;
    originHash: string;
  }): Promise<void>;
  downloadPatchFromPackage(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void>;
  downloadFullUpdate(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void>;
  downloadAndInstallApk(options: {
    url: string;
    target: string;
    hash: string;
  }): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>('Pushy') as Spec | null;
