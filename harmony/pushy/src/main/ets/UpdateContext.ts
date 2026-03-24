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
  private context: common.UIAbilityContext;
  private rootDir: string;
  private preferences: preferences.Preferences;
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
    this.preferences.clear();
    this.applyState(nextState);
    this.preferences.flush();
  }

  public setKv(key: string, value: string): void {
    this.preferences.putSync(key, value);
    this.preferences.flush();
  }

  public getKv(key: string): string {
    return this.readString(key);
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

    const nextState = NativePatchCore.runStateCore(
      STATE_OP_MARK_SUCCESS,
      this.getStateSnapshot(),
    );
    this.applyState(nextState);
    if (nextState.staleVersionToDelete) {
      this.preferences.deleteSync(`hash_${nextState.staleVersionToDelete}`);
    }
    this.preferences.flush();
    this.cleanUp();
  }

  public clearFirstTime(): void {
    const nextState = NativePatchCore.runStateCore(
      STATE_OP_CLEAR_FIRST_TIME,
      this.getStateSnapshot(),
    );
    this.applyState(nextState);
    this.preferences.flush();
    this.cleanUp();
  }

  public clearRollbackMark(): void {
    const nextState = NativePatchCore.runStateCore(
      STATE_OP_CLEAR_ROLLBACK_MARK,
      this.getStateSnapshot(),
    );
    this.applyState(nextState);
    this.preferences.flush();
    this.cleanUp();
  }

  public async downloadFullUpdate(url: string, hash: string): Promise<void> {
    try {
      const params = new DownloadTaskParams();
      params.type = DownloadTaskParams.TASK_TYPE_PATCH_FULL;
      params.url = url;
      params.hash = hash;
      params.targetFile = `${this.rootDir}/${hash}.ppk`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;
      const downloadTask = new DownloadTask(this.context);
      await downloadTask.execute(params);
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
    const params = new DownloadTaskParams();
    params.type = DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD;
    params.url = url;
    params.hash = hash;
    params.targetFile = this.rootDir + '/' + fileName;

    const downloadTask = new DownloadTask(this.context);
    await downloadTask.execute(params);
  }

  public async downloadPatchFromPpk(
    url: string,
    hash: string,
    originHash: string,
  ): Promise<void> {
    const params = new DownloadTaskParams();
    params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
    params.url = url;
    params.hash = hash;
    params.originHash = originHash;
    params.targetFile = `${this.rootDir}/${originHash}_${hash}.ppk.patch`;
    params.unzipDirectory = `${this.rootDir}/${hash}`;
    params.originDirectory = `${this.rootDir}/${params.originHash}`;

    const downloadTask = new DownloadTask(this.context);
    await downloadTask.execute(params);
  }

  public async downloadPatchFromPackage(
    url: string,
    hash: string,
  ): Promise<void> {
    try {
      const params = new DownloadTaskParams();
      params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP;
      params.url = url;
      params.hash = hash;
      params.targetFile = `${this.rootDir}/${hash}.app.patch`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;

      const downloadTask = new DownloadTask(this.context);
      return await downloadTask.execute(params);
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

      const nextState = NativePatchCore.runStateCore(
        STATE_OP_SWITCH_VERSION,
        this.getStateSnapshot(),
        hash,
      );
      this.applyState(nextState);
      this.preferences.flush();
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
      this.applyState(launchState);
      this.preferences.flush();
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
    const nextState = NativePatchCore.runStateCore(
      STATE_OP_ROLLBACK,
      this.getStateSnapshot(),
    );
    this.applyState(nextState);
    this.preferences.flush();
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
