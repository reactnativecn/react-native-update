import preferences from '@ohos.data.preferences';
import fileIo from '@ohos.file.fs';
import { DownloadTask } from './DownloadTask';
import common from '@ohos.app.ability.common';
import { DownloadTaskParams } from './DownloadTaskParams';
import { bundleManager } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import logger from './Logger';
import NativePatchCore, {
  STATE_OP_CLEAR_FIRST_TIME,
  STATE_OP_CLEAR_ROLLBACK_MARK,
  STATE_OP_MARK_SUCCESS,
  STATE_OP_RESOLVE_LAUNCH,
  STATE_OP_ROLLBACK,
  STATE_OP_SWITCH_VERSION,
  StateCoreResult,
} from './NativePatchCore';

type FlushablePreferences = preferences.Preferences & {
  flushSync?: () => void;
};

export class UpdateContext {
  private context: common.UIAbilityContext;
  private rootDir: string;
  private preferences!: preferences.Preferences;
  private static DEBUG: boolean = false;
  private static isUsingBundleUrl: boolean = false;
  private static ignoreRollback: boolean = false;
  private static cachedPackageVersion: string = '';
  private static cachedBuildTime: string = '';
  // 单例：确保 bundle provider 与 TurboModule 共用同一份 preferences 内存状态，
  // 避免 RNOH RN 实例重建后两处 UpdateContext 各自持有 preferences 缓存导致读写分裂。
  private static instance: UpdateContext | null = null;
  private static instanceCounter: number = 0;
  private readonly instanceId: string;

  public static getInstance(context: common.UIAbilityContext): UpdateContext {
    if (!UpdateContext.instance) {
      UpdateContext.instance = new UpdateContext(context);
    }
    return UpdateContext.instance;
  }

  private constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.rootDir = context.filesDir + '/_update';
    this.instanceId = `uc#${++UpdateContext.instanceCounter}`;

    try {
      if (!fileIo.accessSync(this.rootDir)) {
        fileIo.mkdirSync(this.rootDir);
      }
    } catch (e) {
      console.error('Failed to create root directory:', e);
    }
    this.initPreferences();
    this.trace('ctor');
    this.syncStateWithBinaryVersion(
      this.getPackageVersion(),
      this.getBuildTime(),
    );
  }

  /**
   * 诊断日志：打印本实例 id 与关键状态，用于定位 preferences 多实例 / 状态分裂问题。
   * 通过 hilog 输出，prefix=pushy，可在 hilog 中按 "UpdateContext" 过滤。
   */
  private trace(point: string): void {
    const snap = this.getStateSnapshot();
    logger.debug(
      'UpdateContext',
      `trace id=${this.instanceId} ${point}` +
        ` pkg=${snap.packageVersion} bt=${snap.buildTime}` +
        ` cv=${snap.currentVersion} lv=${snap.lastVersion}` +
        ` ft=${snap.firstTime} fto=${snap.firstTimeOk}` +
        ` rb=${snap.rolledBackVersion}` +
        ` flm=${this.readString('firstLoadMarked')}` +
        ` uuidSet=${!!this.readString('uuid')}`,
    );
  }

  /** 对外诊断入口，供 TurboModule 在 getConstants 等关键节点打印状态。 */
  public logStateSnapshot(point: string): void {
    this.trace(point);
  }

  private initPreferences() {
    try {
      this.preferences = preferences.getPreferencesSync(this.context, {
        name: 'update',
      });
    } catch (e) {
      // Fail fast: a missing preferences store means no state can be persisted,
      // which disables rollback protection. Rethrow so the failure surfaces at
      // construction time instead of later as an unrelated TypeError on the
      // undefined `preferences` handle.
      console.error('Failed to init preferences:', e);
      throw e;
    }
  }

  private getBundleFlags(): bundleManager.BundleFlag {
    return bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
  }

  public getPackageVersion(): string {
    if (UpdateContext.cachedPackageVersion) {
      return UpdateContext.cachedPackageVersion;
    }
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(
        this.getBundleFlags(),
      );
      UpdateContext.cachedPackageVersion = bundleInfo?.versionName || 'Unknown';
      return UpdateContext.cachedPackageVersion;
    } catch (error) {
      console.error('Failed to get bundle info:', error);
      return '';
    }
  }

  public getBuildTime(): string {
    if (UpdateContext.cachedBuildTime) {
      return UpdateContext.cachedBuildTime;
    }
    try {
      const content =
        this.context.resourceManager.getRawFileContentSync('meta.json');
      const metaData = JSON.parse(
        new util.TextDecoder().decodeToString(content),
      ) as Record<string, string | number | boolean | null | undefined>;
      if (metaData.pushy_build_time) {
        UpdateContext.cachedBuildTime = String(metaData.pushy_build_time);
        return UpdateContext.cachedBuildTime;
      }
    } catch (error) {
      console.error('Failed to read build time from raw file:', error);
    }
    return '';
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

  private flushPreferences(reason: string): void {
    const flushablePreferences = this.preferences as FlushablePreferences;
    if (typeof flushablePreferences.flushSync === 'function') {
      try {
        flushablePreferences.flushSync();
        return;
      } catch (error) {
        console.error(`Failed to flushSync preferences for ${reason}:`, error);
        // fall through to async flush rather than failing the whole operation
      }
    }
    // flushSync unavailable or failed: writes are already applied in memory via
    // putSync/deleteSync; persist asynchronously as a best-effort so the state
    // operation still succeeds instead of throwing (which is worse than a
    // slightly delayed persist).
    this.preferences.flush().catch((error: Object) => {
      console.error(`Failed to flush preferences for ${reason}:`, error);
    });
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
      markFirstLoadMarker?: boolean;
      clearFirstLoadMarker?: boolean;
    } = {},
  ): void {
    if (options.clearExisting) {
      this.preferences.clear();
    }
    this.applyState(state);
    if (options.removeStaleHash && state.staleVersionToDelete) {
      this.preferences.deleteSync(`hash_${state.staleVersionToDelete}`);
    }
    if (options.markFirstLoadMarker) {
      this.preferences.putSync('firstLoadMarked', 'true');
    }
    if (options.clearFirstLoadMarker) {
      this.preferences.deleteSync('firstLoadMarked');
    }
    this.flushPreferences('persist state');
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
      clearFirstLoadMarker?: boolean;
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
    if (!packageVersion || !buildTime) {
      return;
    }
    const currentState = this.getStateSnapshot();
    const nextState = NativePatchCore.syncStateWithBinaryVersion(
      packageVersion,
      buildTime,
      currentState,
    );
    if (!nextState.changed) {
      return;
    }

    logger.info(
      'UpdateContext',
      `binary version changed, resetting update state id=${this.instanceId}`,
    );
    UpdateContext.ignoreRollback = false;
    this.cleanUp();
    // 仅重置状态机字段（currentVersion / lastVersion / firstTime / firstTimeOk /
    // rolledBackVersion）。不再 clearExisting，避免连带清除 uuid / firstLoadMarked /
    // hash_* 等与 binary 版本无关的 KV —— 它们在多实例场景下本就脆弱，连带清除会
    // 让 getConstants() 永远读到空，从而 isFirstTime=false、markSuccess 永不执行。
    this.persistState(nextState);
  }

  public setKv(key: string, value: string): void {
    this.preferences.putSync(key, value);
    this.flushPreferences(`set key ${key}`);
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

    this.runStateOperation(STATE_OP_MARK_SUCCESS, '', {
      removeStaleHash: true,
      cleanUp: true,
    });
  }

  public clearFirstTime(): void {
    this.runStateOperation(STATE_OP_CLEAR_FIRST_TIME, '', {
      cleanUp: true,
      clearFirstLoadMarker: true,
    });
  }

  public clearRollbackMark(): void {
    this.runStateOperation(STATE_OP_CLEAR_ROLLBACK_MARK, '', {
      cleanUp: true,
    });
  }

  /**
   * 恢复到二进制内置包：清空整个更新状态机（下次启动即回内置 bundle）并删除
   * 全部已下载版本。仅保留 uuid —— 它标识安装实例、用于灰度分桶，reset 不应改变。
   */
  public resetToPackagedBundle(): void {
    this.trace('resetToPackagedBundle:before');
    const state = this.getStateSnapshot();
    const resetState: StateCoreResult = {
      packageVersion: state.packageVersion,
      buildTime: state.buildTime,
      currentVersion: '',
      lastVersion: '',
      firstTime: false,
      firstTimeOk: true,
      rolledBackVersion: '',
    };
    // 删除已下载版本的 hash_* 元信息（不走 clear()：它是异步的，且会连带清掉
    // uuid —— 见 syncStateWithBinaryVersion 的注释）。getAllSync 在旧 SDK 上
    // 可能不存在，此时残留的 hash_* 只是无害孤儿数据，不影响 reset 语义。
    const prefsWithGetAll = this.preferences as preferences.Preferences & {
      getAllSync?: () => Record<string, unknown>;
    };
    if (typeof prefsWithGetAll.getAllSync === 'function') {
      try {
        const all = prefsWithGetAll.getAllSync();
        for (const key of Object.keys(all)) {
          if (key.startsWith('hash_')) {
            this.preferences.deleteSync(key);
          }
        }
      } catch (e: any) {
        console.error('Failed to clear hash info on reset:', e);
      }
    }
    this.persistState(resetState, { clearFirstLoadMarker: true });
    UpdateContext.ignoreRollback = false;

    // maxAgeDays=0 且不保留任何版本：全量删除下载目录内容（后台线程，尽力而为）
    NativePatchCore.cleanupOldEntries(this.rootDir, '', '', 0).catch(
      (error: Object) => {
        console.error('reset cleanup failed:', error);
      },
    );
    this.trace('resetToPackagedBundle:after');
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

      this.trace(`switchVersion:before ${hash}`);
      this.runStateOperation(STATE_OP_SWITCH_VERSION, hash);
      UpdateContext.ignoreRollback = false;
      this.trace(`switchVersion:after ${hash}`);
    } catch (e) {
      console.error('Failed to switch version:', e);
      throw e;
    }
  }

  public consumeFirstLoadMarker(): boolean {
    const marked = this.readString('firstLoadMarked') === 'true';
    this.trace(`consumeFirstLoadMarker:marked=${marked}`);
    if (marked) {
      this.preferences.deleteSync('firstLoadMarked');
      this.flushPreferences('clear first load marker');
    }
    return marked;
  }

  public getBundleUrl() {
    UpdateContext.isUsingBundleUrl = true;
    this.trace('getBundleUrl:enter');
    const stateBeforeLaunch = this.getStateSnapshot();
    const launchState = NativePatchCore.runStateCore(
      STATE_OP_RESOLVE_LAUNCH,
      stateBeforeLaunch,
      '',
      UpdateContext.ignoreRollback,
      true,
    );
    if (launchState.didRollback) {
      // The crash-protection rollback: the new version never called
      // markSuccess. Keep this visible in release logs.
      console.error(
        `Version ${stateBeforeLaunch.currentVersion} was not marked as successful,` +
          ` rolled back to ${launchState.currentVersion}`,
      );
    }
    if (launchState.didRollback || launchState.consumedFirstTime) {
      this.persistState(launchState, {
        markFirstLoadMarker: launchState.consumedFirstTime,
      });
    }
    if (launchState.consumedFirstTime) {
      UpdateContext.ignoreRollback = true;
    }
    this.trace(
      `getBundleUrl:load=${launchState.loadVersion}` +
        ` consumed=${launchState.consumedFirstTime}` +
        ` rollback=${launchState.didRollback}`,
    );

    let version = launchState.loadVersion || '';
    // Guard the rollback chain against cycles: a corrupted state returning an
    // already-visited version would otherwise spin this loop forever during
    // startup (Android has the same guard).
    const visitedVersions = new Set<string>();
    while (version && !visitedVersions.has(version)) {
      visitedVersions.add(version);
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
    const cv = this.getStateSnapshot().currentVersion || '';
    this.trace(`getCurrentVersion:${cv}`);
    return cv;
  }

  private rollBack(): string {
    const stateBefore = this.getStateSnapshot();
    const nextState = this.runStateOperation(STATE_OP_ROLLBACK);
    console.error(
      `Rolling back version ${stateBefore.currentVersion} to ${nextState.currentVersion}`,
    );
    return nextState.currentVersion || '';
  }

  public cleanUp(): void {
    const state = this.getStateSnapshot();
    // cleanupOldEntries now runs on a native worker thread (returns a Promise).
    // Cleanup is best-effort background maintenance and no caller depends on its
    // completion, so fire-and-forget it off the UI thread and just log failures
    // instead of blocking the state operation (or cold start) on disk I/O.
    NativePatchCore.cleanupOldEntries(
      this.rootDir,
      state.currentVersion || '',
      state.lastVersion || '',
      3,
    ).catch((error: Object) => {
      console.error('cleanupOldEntries failed:', error);
    });
  }

  public getIsUsingBundleUrl(): boolean {
    return UpdateContext.isUsingBundleUrl;
  }
}
