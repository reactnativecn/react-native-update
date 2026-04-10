import preferences from '@ohos.data.preferences';
import fileIo from '@ohos.file.fs';
import { DownloadTask } from './DownloadTask';
import common from '@ohos.app.ability.common';
import { DownloadTaskParams } from './DownloadTaskParams';
import NativePatchCore, {
  STATE_OP_CLEAR_FIRST_TIME,
  STATE_OP_CLEAR_ROLLBACK_MARK,
  STATE_OP_MARK_SUCCESS,
  STATE_OP_RESOLVE_LAUNCH,
  STATE_OP_ROLLBACK,
  STATE_OP_SWITCH_VERSION,
  StateCoreResult,
} from './NativePatchCore';

export class UpdateContext {
  private static readonly KEY_BUNDLE_HASH_CACHE_IDENTITY =
    'bundleHashCacheIdentity';
  private static readonly KEY_BUNDLE_HASH_CACHE_VALUE = 'bundleHashCacheValue';
  private context: common.UIAbilityContext;
  private rootDir: string;
  private preferences!: preferences.Preferences;
  private static DEBUG: boolean = false;
  private static isUsingBundleUrl: boolean = false;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.rootDir = context.filesDir + '/_update';

    try {
      if (!fileIo.accessSync(this.rootDir)) {
        fileIo.mkdirSync(this.rootDir);
      }
    } catch (e) {
      console.error('Failed to create root directory:', e);
    }
    this.initPreferences();
  }

  private initPreferences() {
    try {
      this.preferences = preferences.getPreferencesSync(this.context, {
        name: 'update',
      });
    } catch (e) {
      console.error('Failed to init preferences:', e);
    }
  }

  private readString(key: string): string {
    const value = this.preferences.getSync(key, '') as
      | string
      | boolean
      | number
      | null
      | undefined;
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    return '';
  }

  private readBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.preferences.getSync(key, defaultValue) as
      | string
      | boolean
      | number
      | null
      | undefined;
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (value === 'true') {
        return true;
      }
      if (value === 'false') {
        return false;
      }
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    return defaultValue;
  }

  private putNullableString(key: string, value?: string): void {
    if (value) {
      this.preferences.putSync(key, value);
      return;
    }
    this.preferences.deleteSync(key);
  }

  private getBundlePath(hash: string): string {
    return `${this.rootDir}/${hash}/bundle.harmony.js`;
  }

  private getStateSnapshot(): StateCoreResult {
    return {
      packageVersion: this.readString('packageVersion'),
      buildTime: this.readString('buildTime'),
      currentVersion: this.readString('currentVersion'),
      lastVersion: this.readString('lastVersion'),
      firstTime: this.readBoolean('firstTime', false),
      firstTimeOk: this.readBoolean('firstTimeOk', true),
      rolledBackVersion: this.readString('rolledBackVersion'),
    };
  }

  private applyState(state: StateCoreResult): void {
    this.putNullableString('packageVersion', state.packageVersion);
    this.putNullableString('buildTime', state.buildTime);
    this.putNullableString('currentVersion', state.currentVersion);
    this.putNullableString('lastVersion', state.lastVersion);
    this.preferences.putSync('firstTime', !!state.firstTime);
    this.preferences.putSync('firstTimeOk', state.firstTimeOk !== false);
    this.putNullableString('rolledBackVersion', state.rolledBackVersion);
  }

  private persistState(
    state: StateCoreResult,
    options: {
      clearExisting?: boolean;
      removeStaleHash?: boolean;
      cleanUp?: boolean;
    } = {},
  ): void {
    if (options.clearExisting) {
      this.preferences.clear();
    }
    this.applyState(state);
    if (options.removeStaleHash && state.staleVersionToDelete) {
      this.preferences.deleteSync(`hash_${state.staleVersionToDelete}`);
    }
    this.preferences.flush();
    if (options.cleanUp) {
      this.cleanUp();
    }
  }

  private runStateOperation(
    operation: number,
    stringArg: string = '',
    options: {
      removeStaleHash?: boolean;
      cleanUp?: boolean;
    } = {},
  ): StateCoreResult {
    const nextState = NativePatchCore.runStateCore(
      operation,
      this.getStateSnapshot(),
      stringArg,
    );
    this.persistState(nextState, options);
    return nextState;
  }

  private createTaskParams(
    type: number,
    url: string,
    hash: string,
  ): DownloadTaskParams {
    const params = new DownloadTaskParams();
    params.type = type;
    params.url = url;
    params.hash = hash;
    return params;
  }

  private async executeTask(params: DownloadTaskParams): Promise<void> {
    const downloadTask = new DownloadTask(this.context);
    await downloadTask.execute(params);
  }

  public syncStateWithBinaryVersion(
    packageVersion: string,
    buildTime: string,
  ): void {
    const currentState = this.getStateSnapshot();
    const nextState = NativePatchCore.syncStateWithBinaryVersion(
      packageVersion,
      buildTime,
      currentState,
    );
    if (!nextState.changed) {
      return;
    }

    this.cleanUp();
    this.persistState(nextState, { clearExisting: true });
  }

  public setKv(key: string, value: string): void {
    this.preferences.putSync(key, value);
    this.preferences.flush();
  }

  public getKv(key: string): string {
    return this.readString(key);
  }

  public getBundleHash(
    packageVersion: string,
    buildTime: string,
  ): string {
    const identity = `embedded:${packageVersion}:${buildTime}`;
    const cachedIdentity = this.readString(
      UpdateContext.KEY_BUNDLE_HASH_CACHE_IDENTITY,
    );
    const cachedValue = this.readString(
      UpdateContext.KEY_BUNDLE_HASH_CACHE_VALUE,
    );
    if (identity === cachedIdentity && cachedValue) {
      return cachedValue;
    }

    const bundleBytes = this.readEmbeddedBundleBytesSync();
    if (!bundleBytes) {
      return '';
    }

    const bundleHash = NativePatchCore.sha256Hex(bundleBytes);
    this.preferences.putSync(
      UpdateContext.KEY_BUNDLE_HASH_CACHE_IDENTITY,
      identity,
    );
    this.preferences.putSync(
      UpdateContext.KEY_BUNDLE_HASH_CACHE_VALUE,
      bundleHash,
    );
    this.preferences.flush();
    return bundleHash;
  }

  private readEmbeddedBundleBytesSync(): Uint8Array | null {
    try {
      const content = this.context.resourceManager.getRawFileContentSync(
        'bundle.harmony.js',
      );
      return new Uint8Array(content);
    } catch (error) {
      console.error('Failed to read embedded Harmony bundle:', error);
      return null;
    }
  }

  public isFirstTime(): boolean {
    return this.getStateSnapshot().firstTime;
  }

  public rolledBackVersion(): string {
    return this.getStateSnapshot().rolledBackVersion || '';
  }

  public markSuccess(): void {
    if (UpdateContext.DEBUG) {
      return;
    }

    this.runStateOperation(STATE_OP_MARK_SUCCESS, '', {
      removeStaleHash: true,
      cleanUp: true,
    });
  }

  public clearFirstTime(): void {
    this.runStateOperation(STATE_OP_CLEAR_FIRST_TIME, '', { cleanUp: true });
  }

  public clearRollbackMark(): void {
    this.runStateOperation(STATE_OP_CLEAR_ROLLBACK_MARK, '', {
      cleanUp: true,
    });
  }

  public async downloadFullUpdate(url: string, hash: string): Promise<void> {
    try {
      const params = this.createTaskParams(
        DownloadTaskParams.TASK_TYPE_PATCH_FULL,
        url,
        hash,
      );
      params.targetFile = `${this.rootDir}/${hash}.ppk`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;
      await this.executeTask(params);
    } catch (e) {
      console.error('Failed to download full update:', e);
      throw e;
    }
  }

  public async downloadFile(
    url: string,
    hash: string,
    fileName: string,
  ): Promise<void> {
    const params = this.createTaskParams(
      DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD,
      url,
      hash,
    );
    params.targetFile = this.rootDir + '/' + fileName;
    await this.executeTask(params);
  }

  public async downloadPatchFromPpk(
    url: string,
    hash: string,
    originHash: string,
  ): Promise<void> {
    const params = this.createTaskParams(
      DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK,
      url,
      hash,
    );
    params.originHash = originHash;
    params.targetFile = `${this.rootDir}/${originHash}_${hash}.ppk.patch`;
    params.unzipDirectory = `${this.rootDir}/${hash}`;
    params.originDirectory = `${this.rootDir}/${params.originHash}`;
    await this.executeTask(params);
  }

  public async downloadPatchFromPackage(
    url: string,
    hash: string,
  ): Promise<void> {
    try {
      const params = this.createTaskParams(
        DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP,
        url,
        hash,
      );
      params.targetFile = `${this.rootDir}/${hash}.app.patch`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;
      return await this.executeTask(params);
    } catch (e) {
      console.error('Failed to download package patch:', e);
      throw e;
    }
  }

  public switchVersion(hash: string): void {
    try {
      const bundlePath = this.getBundlePath(hash);
      if (!fileIo.accessSync(bundlePath)) {
        throw Error(`Bundle version ${hash} not found.`);
      }

      this.runStateOperation(STATE_OP_SWITCH_VERSION, hash);
    } catch (e) {
      console.error('Failed to switch version:', e);
      throw e;
    }
  }

  public getBundleUrl() {
    UpdateContext.isUsingBundleUrl = true;
    const launchState = NativePatchCore.runStateCore(
      STATE_OP_RESOLVE_LAUNCH,
      this.getStateSnapshot(),
      '',
      false,
      false,
    );
    if (launchState.didRollback || launchState.consumedFirstTime) {
      this.persistState(launchState);
    }

    let version = launchState.loadVersion || '';
    while (version) {
      const bundleFile = this.getBundlePath(version);
      try {
        if (!fileIo.accessSync(bundleFile)) {
          console.error(`Bundle version ${version} not found.`);
          version = this.rollBack();
          continue;
        }
        return bundleFile;
      } catch (e) {
        console.error('Failed to access bundle file:', e);
        version = this.rollBack();
      }
    }
    return '';
  }

  public getCurrentVersion(): string {
    return this.getStateSnapshot().currentVersion || '';
  }

  private rollBack(): string {
    const nextState = this.runStateOperation(STATE_OP_ROLLBACK);
    return nextState.currentVersion || '';
  }

  public cleanUp(): void {
    const state = this.getStateSnapshot();
    NativePatchCore.cleanupOldEntries(
      this.rootDir,
      state.currentVersion || '',
      state.lastVersion || '',
      7,
    );
  }

  public getIsUsingBundleUrl(): boolean {
    return UpdateContext.isUsingBundleUrl;
  }
}
