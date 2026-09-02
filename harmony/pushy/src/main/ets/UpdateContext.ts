import preferences from '@ohos.data.preferences';
import fileIo from '@ohos.file.fs';
import {
  isInstallComplete,
  readInstallRecord,
  verifyInstallForActivation,
} from './InstallRecord';
import { DownloadTask } from './DownloadTask';
import common from '@ohos.app.ability.common';
import { DownloadTaskParams } from './DownloadTaskParams';
import { bundleManager } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import logger from './Logger';
import {
  KEY_RESP_CACHE,
  scheduleNativeCheck,
} from './NativeCheckOrchestrator';
import NativePatchCore, {
  STATE_OP_CLEAR_FIRST_TIME,
  STATE_OP_CLEAR_ROLLBACK_MARK,
  STATE_OP_MARK_SUCCESS,
  STATE_OP_RESOLVE_LAUNCH,
  STATE_OP_ROLLBACK,
  STATE_OP_SWITCH_VERSION,
  StateCoreResult,
} from './NativePatchCore';
import { assertSafePathComponent } from './PathUtils';
import {
  ERROR_SWITCH_VERSION_FAILED,
  createUpdateError,
  getErrorMessage,
  toUpdateError,
} from './ErrorCodes';

export { isSafePathComponent } from './PathUtils';

const TAG = 'UpdateContext';
// 常规清理保留最近 3 天内触碰过的条目(续传 partial、staging 同样按 mtime)。
const CLEANUP_MAX_AGE_DAYS = 3;

// Preferences.flushSync 是 API 14 才有、getAllSync 老 SDK 声明里没有:HAR 兼容
// API 12,按结构化视图探测(不用交叉类型——ArkTS 不支持)。
interface OptionalPreferencesApi {
  flushSync?: () => void;
  getAllSync?: () => Record<string, unknown>;
}

interface PersistOptions {
  removeStaleHash?: boolean;
  cleanUp?: boolean;
  markFirstLoadMarker?: boolean;
  clearFirstLoadMarker?: boolean;
}

export class UpdateContext {
  private context: common.UIAbilityContext;
  private rootDir: string;
  private preferences!: preferences.Preferences;
  // 宿主传入的调试标志(RNOH isDebugModeEnabled)。debug 下 markSuccess 空转、
  // 不算内嵌 bundle 摘要,与 Android 的 debug 库对齐。HAR 自身没有构建期
  // DEBUG 信号(hvigor 不为 HAR 生成 BuildProfile),所以只看宿主。
  private static DEBUG: boolean = false;
  private static isUsingBundleUrl: boolean = false;
  private static ignoreRollback: boolean = false;
  // 本进程实际加载的热更版本（getBundleUrl 解析成功时记录）。
  // resetToPackagedBundle 不能删它的目录：热更包内的图片等资源是运行时按需
  // 读盘的，静默（不重启）reset 若删掉会导致后续所有未加载过的资源失败。
  // 常规清理同样必须保留它:一次进程内两次切换后 current/last 都不再是它。
  private static launchVersion: string = '';
  // 由 resetToPackagedBundle 递增。原生冷启动检测可能跑数分钟并已握有决策,
  // 期间发生的 reset 必须赢:编排器采样该值,发现变化即放弃激活与响应缓存,
  // 在飞的救援不会把刚被重置掉的版本装回去。
  private static resetGeneration: number = 0;
  private static cachedPackageVersion: string = '';
  private static cachedBuildTime: string = '';
  // 单例：确保 bundle provider 与 TurboModule 共用同一份 preferences 内存状态，
  // 避免 RNOH RN 实例重建后两处 UpdateContext 各自持有 preferences 缓存导致读写分裂。
  private static instance: UpdateContext | null = null;
  private static instanceCounter: number = 0;
  private readonly instanceId: string;

  /**
   * @param isDebugHost 宿主的调试标志(RNOH isDebugModeEnabled)。bundle
   *   provider 先于 TurboModule 构造,不传该参数;TurboModule 随后显式传入时
   *   会重新解析。
   */
  public static getInstance(
    context: common.UIAbilityContext,
    isDebugHost?: boolean,
  ): UpdateContext {
    if (isDebugHost !== undefined) {
      UpdateContext.DEBUG = isDebugHost;
    }
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
      logger.error(TAG, `Failed to create root directory: ${getErrorMessage(e)}`);
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
      TAG,
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
      logger.error(TAG, `Failed to init preferences: ${getErrorMessage(e)}`);
      throw e;
    }
  }

  private optionalPreferencesApi(): OptionalPreferencesApi {
    return this.preferences as unknown as OptionalPreferencesApi;
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
      logger.error(TAG, `Failed to get bundle info: ${getErrorMessage(error)}`);
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
      logger.error(
        TAG,
        `Failed to read build time from raw file: ${getErrorMessage(error)}`,
      );
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

  // >0 while a multi-write commit is open: putSync/deleteSync still apply in
  // memory, the single flush happens when the outermost batch closes. The
  // cold-start round's three writes (hash info, activation, response cache)
  // thus reach disk as one preferences file write, not three.
  private flushBatchDepth = 0;

  private beginFlushBatch(): void {
    this.flushBatchDepth += 1;
  }

  /** 关闭最外层批次时执行唯一一次落盘;返回该次落盘的 promise。 */
  private endFlushBatch(reason: string): Promise<void> {
    this.flushBatchDepth = Math.max(0, this.flushBatchDepth - 1);
    if (this.flushBatchDepth === 0) {
      return this.flushPreferences(reason);
    }
    return Promise.resolve();
  }

  /**
   * 落盘。flushSync(API 14)可用时同步完成;否则返回 preferences.flush() 的
   * promise。有 promise 可拒绝的操作(切换、markSuccess、setKv…)必须 await
   * 它——切换只有真正写进磁盘后才能向 JS 报成功,reloadUpdate 紧接着就会
   * 杀进程(SR-5,Android 是 persistEditorOrThrow)。无法 await 的同步路径
   * (启动解析、getConstants)用 flushInBackground,失败只记日志。
   * 批次开着时不落盘,由 endFlushBatch 统一执行。
   */
  private flushPreferences(reason: string): Promise<void> {
    if (this.flushBatchDepth > 0) {
      return Promise.resolve();
    }
    const api = this.optionalPreferencesApi();
    if (typeof api.flushSync === 'function') {
      try {
        api.flushSync();
        return Promise.resolve();
      } catch (error) {
        logger.error(
          TAG,
          `flushSync failed for ${reason}, falling back to flush(): ` +
            getErrorMessage(error),
        );
        // fall through to the async flush rather than failing outright
      }
    }
    return this.preferences.flush().then(
      () => undefined,
      (error: Object) => {
        logger.error(
          TAG,
          `Failed to flush preferences for ${reason}: ${getErrorMessage(error)}`,
        );
        throw error;
      },
    );
  }

  private flushInBackground(reason: string): void {
    this.flushPreferences(reason).catch(() => {
      // 已在 flushPreferences 里记录。
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

  /** 内存写入(不落盘):状态字段 + 可选的陈旧 hash / 首载标记 / 清理。 */
  private writeState(state: StateCoreResult, options: PersistOptions): void {
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
    if (options.cleanUp) {
      this.cleanUp();
    }
  }

  private persistState(
    state: StateCoreResult,
    options: PersistOptions = {},
  ): Promise<void> {
    this.writeState(state, options);
    return this.flushPreferences('persist state');
  }

  /** 跑一步状态机并写入内存;落盘由调用方决定(await 或后台)。 */
  private runStateOperation(
    operation: number,
    stringArg: string = '',
    options: PersistOptions = {},
  ): StateCoreResult {
    const nextState = NativePatchCore.runStateCore(
      operation,
      this.getStateSnapshot(),
      stringArg,
    );
    this.writeState(nextState, options);
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
    params.hash = assertSafePathComponent(hash);
    return params;
  }

  // 串行化下载/补丁任务与破坏性清理（reset 的全量删除、按 mtime 的常规清理）：
  // Android 靠单线程 download executor 天然串行，Harmony 的 NAPI 任务跑在
  // libuv worker 池上，若不排队，reset 的 RemovePathRecursively 可能与正在
  // 写入的解压/打补丁并发，产出"bundle 在、资源半删"的目录且可能被后续
  // switchVersion 激活。
  private taskChain: Promise<void> = Promise.resolve();

  private enqueueSerialTask<T>(job: () => Promise<T>): Promise<T> {
    const run = this.taskChain.then(job);
    this.taskChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async executeTask(params: DownloadTaskParams): Promise<void> {
    await this.enqueueSerialTask(() => {
      const isPatchTask =
        params.type === DownloadTaskParams.TASK_TYPE_PATCH_FULL ||
        params.type === DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP ||
        params.type === DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
      // Re-check only when this queued job actually starts. A JS download may
      // have completed while the cold-start duplicate waited behind it.
      if (isPatchTask && this.hasDownloadedVersion(params.hash)) {
        return Promise.resolve();
      }
      const downloadTask = new DownloadTask(this.context);
      return downloadTask.execute(params);
    });
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
      TAG,
      `binary version changed, resetting update state id=${this.instanceId}`,
    );
    UpdateContext.ignoreRollback = false;
    this.cleanUp();
    // 仅重置状态机字段（currentVersion / lastVersion / firstTime / firstTimeOk /
    // rolledBackVersion）。不再 clearExisting，避免连带清除 uuid / firstLoadMarked /
    // hash_* 等与 binary 版本无关的 KV —— 它们在多实例场景下本就脆弱，连带清除会
    // 让 getConstants() 永远读到空，从而 isFirstTime=false、markSuccess 永不执行。
    this.writeState(nextState, {});
    this.flushInBackground('sync binary version');
  }

  /** 写入并落盘;flushSync 不可用时以 flush() 的结果拒绝。 */
  public setKv(key: string, value: string): Promise<void> {
    this.preferences.putSync(key, value);
    return this.flushPreferences(`set key ${key}`);
  }

  public getKv(key: string): string {
    return this.readString(key);
  }

  public removeKv(key: string): Promise<void> {
    this.preferences.deleteSync(key);
    return this.flushPreferences(`remove key ${key}`);
  }

  public isFirstTime(): boolean {
    return this.getStateSnapshot().firstTime;
  }

  public rolledBackVersion(): string {
    return this.getStateSnapshot().rolledBackVersion || '';
  }

  public async markSuccess(): Promise<void> {
    if (UpdateContext.DEBUG) {
      return;
    }

    this.runStateOperation(STATE_OP_MARK_SUCCESS, '', {
      removeStaleHash: true,
      cleanUp: true,
    });
    await this.flushPreferences('mark success');
  }

  public async clearFirstTime(): Promise<void> {
    this.runStateOperation(STATE_OP_CLEAR_FIRST_TIME, '', {
      cleanUp: true,
      clearFirstLoadMarker: true,
    });
    await this.flushPreferences('clear first time');
  }

  /** getConstants(同步)里调用:落盘失败只记日志。 */
  public clearRollbackMark(): void {
    this.runStateOperation(STATE_OP_CLEAR_ROLLBACK_MARK, '', {
      cleanUp: true,
    });
    this.flushInBackground('clear rollback mark');
  }

  /**
   * 恢复到二进制内置包：清空整个更新状态机（下次启动即回内置 bundle）并删除
   * 已下载版本——仅保留当前运行版本的目录（静默 reset 不能破坏运行中 bundle
   * 的按需资源加载）。uuid 保留 —— 它标识安装实例、用于灰度分桶，reset 不应改变。
   * 状态与响应缓存一次落盘;落盘失败拒绝(JS 按 RESET_FAILED 处理)。
   */
  public async resetToPackagedBundle(): Promise<void> {
    this.trace('resetToPackagedBundle:before');
    // 实时读取二进制身份（与 Android/iOS 对齐），而非 preferences 快照：
    // meta.json 读取失败时快照可能为空，reset 持久化空值会让下次启动误判
    // binary 变更多做一轮 cleanUp+persist。
    const resetState: StateCoreResult = {
      packageVersion: this.getPackageVersion(),
      buildTime: this.getBuildTime(),
      currentVersion: '',
      lastVersion: '',
      firstTime: false,
      firstTimeOk: true,
      rolledBackVersion: '',
    };
    // 先让在飞的原生检测轮次失效,再清理状态:随后在同一(单线程)执行序里
    // 提交的轮次会看到新代数并整轮丢弃。
    UpdateContext.resetGeneration += 1;
    this.beginFlushBatch();
    let flushed: Promise<void> = Promise.resolve();
    try {
      // 删除已下载版本的 hash_* 元信息（不走 clear()：它是异步的，且会连带清掉
      // uuid —— 见 syncStateWithBinaryVersion 的注释）。getAllSync 在旧 SDK 上
      // 可能不存在，此时残留的 hash_* 只是无害孤儿数据，不影响 reset 语义。
      const api = this.optionalPreferencesApi();
      if (typeof api.getAllSync === 'function') {
        try {
          const all = api.getAllSync();
          for (const key of Object.keys(all)) {
            if (key.startsWith('hash_')) {
              this.preferences.deleteSync(key);
            }
          }
        } catch (e) {
          logger.error(
            TAG,
            `Failed to clear hash info on reset: ${getErrorMessage(e)}`,
          );
        }
      }
      this.writeState(resetState, { clearFirstLoadMarker: true });
      // 缓存里的响应仍在宣告本次 reset 刚删掉的版本,一并丢弃,避免 JS 侧复用。
      this.preferences.deleteSync(KEY_RESP_CACHE);
    } finally {
      flushed = this.endFlushBatch('reset to packaged bundle');
    }
    UpdateContext.ignoreRollback = false;
    await flushed;

    // maxAgeDays=0：删除下载目录内容，仅保留当前运行版本的目录（残留目录由
    // 下次常规清理回收）。挂到串行任务链尾，避免与在飞的解压/打补丁并发。
    this.enqueueSerialTask(() =>
      NativePatchCore.cleanupOldEntries(
        this.rootDir,
        [UpdateContext.launchVersion].filter(name => name.length > 0),
        0,
      ),
    ).catch((error: Object) => {
      logger.error(TAG, `reset cleanup failed: ${getErrorMessage(error)}`);
    });
    this.trace('resetToPackagedBundle:after');
  }

  /** 供原生检测编排器采样/比对的 reset 代数(见 resetGeneration 注释)。 */
  public getResetGeneration(): number {
    return UpdateContext.resetGeneration;
  }

  /**
   * 一次性提交原生检测轮次的全部持久化结果(版本元信息、激活、响应缓存)。
   * 切换校验(含工作线程上的 bundle 摘要复核)放在第一个 putSync 之前:校验
   * 失败时什么都不写,不会出现"元信息已落盘、切换没发生"的半提交。校验后
   * 复核 reset 代数,之后到写入完成之间没有 await(ArkTS 单线程),因此不存在
   * 可插入 reset 的窗口(iOS/Android 用锁达到同一效果)。三项写入以一次
   * flush 落盘,失败拒绝。返回是否提交成功。
   */
  public async commitNativeCheckResult(
    expectedGeneration: number,
    hash: string,
    hashInfoJson: string,
    activate: boolean,
    responseCacheJson: string,
  ): Promise<boolean> {
    if (UpdateContext.resetGeneration !== expectedGeneration) {
      return false;
    }
    const shouldSwitch = activate && !!hash;
    if (shouldSwitch) {
      await this.verifyActivation(hash);
      if (UpdateContext.resetGeneration !== expectedGeneration) {
        return false;
      }
    }
    // One flush for the whole round (see beginFlushBatch): version info,
    // activation and response cache land together or not at all.
    this.beginFlushBatch();
    let flushed: Promise<void> = Promise.resolve();
    try {
      if (hash && hashInfoJson) {
        this.preferences.putSync(`hash_${hash}`, hashInfoJson);
      }
      if (shouldSwitch) {
        this.applySwitch(hash);
      }
      if (responseCacheJson) {
        this.preferences.putSync(KEY_RESP_CACHE, responseCacheJson);
      }
    } finally {
      flushed = this.endFlushBatch('commit native check result');
    }
    await flushed;
    return true;
  }

  public async downloadFullUpdate(
    url: string,
    hash: string,
    deadlineUptimeMs: number = 0,
  ): Promise<void> {
    try {
      const params = this.createTaskParams(
        DownloadTaskParams.TASK_TYPE_PATCH_FULL,
        url,
        hash,
      );
      params.targetFile = `${this.rootDir}/${hash}.ppk`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;
      params.deadlineUptimeMs = deadlineUptimeMs;
      await this.executeTask(params);
    } catch (e) {
      logger.error(TAG, `Failed to download full update: ${getErrorMessage(e)}`);
      throw e;
    }
  }

  public async downloadPatchFromPpk(
    url: string,
    hash: string,
    originHash: string,
    deadlineUptimeMs: number = 0,
  ): Promise<void> {
    const params = this.createTaskParams(
      DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK,
      url,
      hash,
    );
    params.originHash = assertSafePathComponent(originHash);
    params.targetFile = `${this.rootDir}/${originHash}_${hash}.ppk.patch`;
    params.unzipDirectory = `${this.rootDir}/${hash}`;
    params.originDirectory = `${this.rootDir}/${params.originHash}`;
    params.deadlineUptimeMs = deadlineUptimeMs;
    await this.executeTask(params);
  }

  public async downloadPatchFromPackage(
    url: string,
    hash: string,
    deadlineUptimeMs: number = 0,
  ): Promise<void> {
    try {
      const params = this.createTaskParams(
        DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP,
        url,
        hash,
      );
      params.targetFile = `${this.rootDir}/${hash}.app.patch`;
      params.unzipDirectory = `${this.rootDir}/${hash}`;
      params.deadlineUptimeMs = deadlineUptimeMs;
      return await this.executeTask(params);
    } catch (e) {
      logger.error(
        TAG,
        `Failed to download package patch: ${getErrorMessage(e)}`,
      );
      throw e;
    }
  }

  // 运行中热更版本安装记录里的 bundleSha256(崩溃归因用);内置 bundle /
  // 历史安装 / 记录不可读时为空串。
  public currentBundleSha256(hash: string): string {
    if (!hash) {
      return '';
    }
    try {
      const record = readInstallRecord(
        `${this.rootDir}/${assertSafePathComponent(hash)}`,
      );
      return record?.bundleSha256 ?? '';
    } catch (e) {
      return '';
    }
  }

  // 原生冷启动检测(NativeCheckOrchestrator)用来跳过已就绪版本的重复下载
  // ——alert 类策略下版本已下载但未激活,若不判在这里会每次冷启动重下一遍。
  public hasDownloadedVersion(hash: string): boolean {
    try {
      const safeHash = assertSafePathComponent(hash);
      return fileIo.accessSync(this.getBundlePath(safeHash))
        && isInstallComplete(`${this.rootDir}/${safeHash}`, safeHash);
    } catch (e) {
      return false;
    }
  }

  /**
   * 激活前置校验(同步,不写任何东西):bundle 在盘上,且要么是本 SDK 记录为
   * 完整安装的版本(bundle + 记录),要么是标记机制之前就激活过的历史版本
   * (current/last 里有它)。其他无记录的目录可能是崩溃留下的半成品。
   * 返回是否还需复核安装记录里的 bundle 摘要(历史版本无记录可核)。
   */
  private assertActivatable(safeHash: string): boolean {
    if (!fileIo.accessSync(this.getBundlePath(safeHash))) {
      throw createUpdateError(
        ERROR_SWITCH_VERSION_FAILED,
        `Bundle version ${safeHash} not found.`,
      );
    }
    const legacyActivated =
      this.readString('currentVersion') === safeHash ||
      this.readString('lastVersion') === safeHash;
    if (!this.hasDownloadedVersion(safeHash) && !legacyActivated) {
      throw createUpdateError(
        ERROR_SWITCH_VERSION_FAILED,
        `Bundle version ${safeHash} is incomplete.`,
      );
    }
    return !legacyActivated;
  }

  /**
   * 完整的激活校验(含 native 工作线程上的 bundle 摘要复核),不写状态。
   * 记录里的 bundle 摘要必须与盘上字节一致,才能把下次启动指向它。
   */
  public async verifyActivation(hash: string): Promise<void> {
    const safeHash = assertSafePathComponent(hash);
    if (this.assertActivatable(safeHash)) {
      await verifyInstallForActivation(
        `${this.rootDir}/${safeHash}`,
        safeHash,
        this.getBundlePath(safeHash),
      );
    }
  }

  /** 内存里切换状态(不落盘);调用方负责 flush。 */
  private applySwitch(hash: string): void {
    this.trace(`switchVersion:before ${hash}`);
    this.runStateOperation(STATE_OP_SWITCH_VERSION, hash);
    UpdateContext.ignoreRollback = false;
    this.trace(`switchVersion:after ${hash}`);
  }

  /** 校验 + 切换 + 落盘;任一步失败拒绝(SWITCH_VERSION_FAILED)。 */
  public async switchVersion(hash: string): Promise<void> {
    try {
      const safeHash = assertSafePathComponent(hash);
      await this.verifyActivation(safeHash);
      this.applySwitch(safeHash);
      await this.flushPreferences(`switch version ${safeHash}`);
    } catch (e) {
      logger.error(TAG, `Failed to switch version: ${getErrorMessage(e)}`);
      throw toUpdateError(e, ERROR_SWITCH_VERSION_FAILED);
    }
  }

  public consumeFirstLoadMarker(): boolean {
    const marked = this.readString('firstLoadMarked') === 'true';
    this.trace(`consumeFirstLoadMarker:marked=${marked}`);
    if (marked) {
      this.preferences.deleteSync('firstLoadMarked');
      this.flushInBackground('clear first load marker');
    }
    return marked;
  }

  public getBundleUrl() {
    UpdateContext.isUsingBundleUrl = true;
    this.trace('getBundleUrl:enter');
    let nativeCheckRolledBackVersion = '';
    try {
      const stateBeforeLaunch = this.getStateSnapshot();
      const launchState = NativePatchCore.runStateCore(
        STATE_OP_RESOLVE_LAUNCH,
        stateBeforeLaunch,
        '',
        UpdateContext.ignoreRollback,
        true,
      );
      nativeCheckRolledBackVersion = launchState.rolledBackVersion || '';
      if (launchState.didRollback) {
        // The crash-protection rollback: the new version never called
        // markSuccess. Keep this visible in release logs.
        logger.error(
          TAG,
          `Version ${stateBeforeLaunch.currentVersion} was not marked as successful,` +
            ` rolled back to ${launchState.currentVersion}`,
        );
      }
      if (launchState.didRollback || launchState.consumedFirstTime) {
        // 同步启动路径:落盘失败只记日志(状态已在内存里生效)。
        this.persistState(launchState, {
          markFirstLoadMarker: launchState.consumedFirstTime,
        }).catch(() => {});
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
            logger.error(TAG, `Bundle version ${version} not found.`);
            version = this.rollBack();
            nativeCheckRolledBackVersion = this.rolledBackVersion();
            continue;
          }
          UpdateContext.launchVersion = version;
          nativeCheckRolledBackVersion = this.rolledBackVersion();
          return bundleFile;
        } catch (e) {
          logger.error(TAG, `Failed to access bundle file: ${getErrorMessage(e)}`);
          version = this.rollBack();
          nativeCheckRolledBackVersion = this.rolledBackVersion();
        }
      }
      nativeCheckRolledBackVersion = this.rolledBackVersion();
      return '';
    } finally {
      // State corruption is exactly when the native rescue check is needed;
      // schedule even if state parsing/rollback throws before a normal exit.
      scheduleNativeCheck(this, nativeCheckRolledBackVersion);
    }
  }

  public getCurrentVersion(): string {
    const cv = this.getStateSnapshot().currentVersion || '';
    this.trace(`getCurrentVersion:${cv}`);
    return cv;
  }

  private rollBack(): string {
    const stateBefore = this.getStateSnapshot();
    const nextState = this.runStateOperation(STATE_OP_ROLLBACK);
    this.flushInBackground('rollback');
    logger.error(
      TAG,
      `Rolling back version ${stateBefore.currentVersion} to ${nextState.currentVersion}`,
    );
    return nextState.currentVersion || '';
  }

  /**
   * 常规清理(best-effort 后台维护,无人等待其完成):删除 3 天未触碰且不在
   * 保留名单里的条目。保留 current/last 与本进程启动的版本。挂到串行任务链
   * 上——下载可能正在追加超过 3 天的续传 partial 或填充 staging,按 mtime
   * 的清理若并发跑会把它们当陈旧条目删掉(Android 与下载共用同一单线程
   * executor)。
   */
  public cleanUp(): void {
    const state = this.getStateSnapshot();
    const keepNames = [
      state.currentVersion || '',
      state.lastVersion || '',
      UpdateContext.launchVersion,
    ].filter(name => name.length > 0);
    this.enqueueSerialTask(() =>
      NativePatchCore.cleanupOldEntries(
        this.rootDir,
        keepNames,
        CLEANUP_MAX_AGE_DAYS,
      ),
    ).catch((error: Object) => {
      logger.error(TAG, `cleanupOldEntries failed: ${getErrorMessage(error)}`);
    });
  }

  public getIsUsingBundleUrl(): boolean {
    return UpdateContext.isUsingBundleUrl;
  }

  // bundleHash 缓存:"<packageVersion>|<updateTime>|<sha256hex>"。键标识当前
  // 安装的二进制,每次(覆盖)安装 updateTime 都会变,每个安装只算一次。
  private static readonly KEY_BUNDLE_HASH_CACHE = 'bundleHashCache';

  private getBundleUpdateTime(): number {
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(
        this.getBundleFlags(),
      );
      return bundleInfo?.updateTime ?? 0;
    } catch (error) {
      logger.error(
        TAG,
        `Failed to get bundle update time: ${getErrorMessage(error)}`,
      );
      return 0;
    }
  }

  /**
   * bundleHash = 二进制内嵌 JS bundle 的 sha256 —— 标识二进制本身,与当前运行
   * 的热更版本无关。哈希对象与 pdiff 的源读取完全一致:rawfile 的
   * bundle.harmony.js(DownloadTask.doPatchFromApp 同一读法)。懒计算 + 缓存;
   * 永不失败——空串表示"未知",服务端回退 buildTime 启发式。
   */
  public async getBundleHash(): Promise<string> {
    if (UpdateContext.DEBUG) {
      // debug 下 bundle 由 metro 提供,与 dev 删 buildTime 的行为对齐。
      return '';
    }
    const cachePrefix = `${this.getPackageVersion()}|${this.getBundleUpdateTime()}|`;
    const cached = this.readString(UpdateContext.KEY_BUNDLE_HASH_CACHE);
    if (cached.startsWith(cachePrefix)) {
      return cached.slice(cachePrefix.length);
    }
    let hash = '';
    try {
      // 异步读:TurboModule 跑在 UI 线程,同步读几 MB 会卡主线程一次。C++
      // 哈希本身毫秒级,同步无妨。
      const content =
        await this.context.resourceManager.getRawFileContent('bundle.harmony.js');
      hash = NativePatchCore.sha256Hex(content);
    } catch (error) {
      // rawfile 缺 bundle(未打包 release bundle)是合法的"未知",不是错误。
      logger.info(TAG, `Cannot hash embedded bundle: ${getErrorMessage(error)}`);
      return '';
    }
    if (hash) {
      this.preferences.putSync(
        UpdateContext.KEY_BUNDLE_HASH_CACHE,
        cachePrefix + hash,
      );
      // 缓存落盘失败不影响返回值(下次重算即可)。
      this.flushInBackground('cache bundle hash');
    }
    return hash;
  }
}
