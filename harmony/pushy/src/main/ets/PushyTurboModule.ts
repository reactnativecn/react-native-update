import {
  UITurboModule,
  UITurboModuleContext,
} from '@rnoh/react-native-openharmony/ts';
import common from '@ohos.app.ability.common';
import { bundleManager } from '@kit.AbilityKit';
import logger from './Logger';
import NativePatchCore from './NativePatchCore';
import { UpdateContext } from './UpdateContext';
import { EventHub } from './EventHub';
import {
  KEY_CONFIG,
  markJsCheckCompleted,
  KEY_RESP_CACHE,
} from './NativeCheckOrchestrator';
import {
  ERROR_FILE_OPERATION_FAILED,
  ERROR_INVALID_HASH_INFO,
  ERROR_INVALID_OPTIONS,
  ERROR_MARK_SUCCESS_FAILED,
  ERROR_RESET_FAILED,
  ERROR_RESTART_FAILED,
  ERROR_SWITCH_VERSION_FAILED,
  ERROR_UNSUPPORTED_PLATFORM,
  createUpdateError,
  getErrorMessage,
  toUpdateError,
} from './ErrorCodes';

export { getErrorMessage } from './ErrorCodes';

const TAG = 'PushyTurboModule';

interface RestartWant {
  bundleName: string;
  abilityName?: string;
}

// applicationContext.restartApp 是 API 12 才有的可选能力,按结构探测。
interface RestartableApplicationContext {
  restartApp?: (want: RestartWant) => void;
}

interface ReloadEventEmitter {
  emit(event: string, payload: Object): void;
}

// RNOH 的 devToolsController 不在公开的 UITurboModuleContext 类型里。
interface DevToolsControllerHolder {
  devToolsController?: { eventEmitter: ReloadEventEmitter };
}

export function validateHashInfo(info: string): void {
  let valid = false;
  try {
    const parsed = JSON.parse(info) as Object | null;
    valid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch (e) {
    valid = false;
  }
  if (!valid) {
    throw createUpdateError(ERROR_INVALID_HASH_INFO, 'invalid json string');
  }
}

export class PushyTurboModule extends UITurboModule {
  public static readonly NAME = 'Pushy';

  mUiCtx: common.UIAbilityContext;
  context: UpdateContext;

  constructor(protected ctx: UITurboModuleContext) {
    super(ctx);
    if (ctx.isDebugModeEnabled) {
      // 宿主处于 RN 调试模式:打开 debug 级日志,方便接入排查。
      logger.setDebug(true);
    }
    logger.debug(TAG, ',PushyTurboModule constructor');
    this.mUiCtx = ctx.uiAbilityContext;
    this.context = UpdateContext.getInstance(
      this.mUiCtx,
      ctx.isDebugModeEnabled,
    );
    EventHub.getInstance().setRNInstance(ctx.rnInstance);
  }

  // RNOH 销毁 TurboModule 时的钩子:释放对已销毁 RNInstance 的引用(只在
  // EventHub 仍指向它时,见 EventHub.clearRNInstance)。
  __onDestroy__(): void {
    EventHub.getInstance().clearRNInstance(this.ctx.rnInstance);
  }

  private getBundleFlags(): bundleManager.BundleFlag {
    return bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
  }

  private requireHash(hash: string, methodName: string): string {
    if (!hash) {
      throw createUpdateError(
        ERROR_INVALID_OPTIONS,
        `${methodName}: empty hash`,
      );
    }
    return hash;
  }

  private softReload(): void {
    const holder = this.ctx as unknown as DevToolsControllerHolder;
    const devToolsController = holder.devToolsController;
    if (devToolsController) {
      devToolsController.eventEmitter.emit('RELOAD', { reason: 'HotReload2' });
    }
  }

  private async restartAbility(): Promise<void> {
    const bundleInfo = await bundleManager.getBundleInfoForSelf(
      this.getBundleFlags(),
    );
    const want: RestartWant = {
      bundleName: bundleInfo.name,
      abilityName: this.mUiCtx.abilityInfo?.name,
    };
    try {
      const applicationContext =
        this.mUiCtx.getApplicationContext() as unknown as RestartableApplicationContext;
      if (applicationContext && typeof applicationContext.restartApp === 'function') {
        logger.debug(TAG, 'restartAbility via applicationContext.restartApp');
        applicationContext.restartApp(want);
        return;
      }
    } catch (e) {
      logger.error(TAG, `restartAbility via restartApp failed: ${getErrorMessage(e)}`);
    }

    logger.debug(TAG, 'restartAbility via startAbility fallback');
    try {
      await this.mUiCtx.startAbility(want);
      await this.mUiCtx.terminateSelf();
    } catch (e) {
      logger.error(TAG, `restartAbility via startAbility/terminateSelf fallback failed: ${getErrorMessage(e)}`);
      // Last resort: terminateSelf first
      await this.mUiCtx.terminateSelf();
      await this.mUiCtx.startAbility(want);
    }
  }

  private async reloadBridge(): Promise<void> {
    if (this.ctx.isDebugModeEnabled) {
      logger.debug(TAG, 'reloadBridge via devToolsController RELOAD (debug mode)');
      this.softReload();
    } else {
      logger.debug(TAG, 'reloadBridge via restartAbility (release mode)');
      // If the process truly restarts, this timer dies with it. It only fires
      // when the app is still alive after 1.5s — i.e. restartApp resolved but
      // was silently suppressed (HarmonyOS rate-limits restarts within a few
      // seconds of cold start / of a previous call) — which is exactly when the
      // soft reload must take over. So the timer is NOT cleared on the success
      // path, only in the catch branch where the soft reload runs immediately.
      const fallbackTimer = setTimeout(() => {
        logger.warn(TAG, 'restartAbility did not restart the app within 1.5s, triggering soft reload fallback');
        this.softReload();
      }, 1500);

      try {
        await this.restartAbility();
      } catch (error) {
        clearTimeout(fallbackTimer);
        logger.error(TAG, `restartAbility failed: ${getErrorMessage(error)}, triggering soft reload fallback`);
        this.softReload();
      }
    }
  }

  getConstants(): Object {
    logger.debug(TAG, ',call getConstants');
    this.context.logStateSnapshot('getConstants:enter');
    const packageVersion = this.context.getPackageVersion();
    const buildTime = this.context.getBuildTime();
    this.context.syncStateWithBinaryVersion(packageVersion, buildTime);

    const currentVersion = this.context.getCurrentVersion();
    const currentVersionInfo = currentVersion
      ? this.context.getKv(`hash_${currentVersion}`)
      : '';
    const currentBundleSha256 = this.context.currentBundleSha256(currentVersion);
    const isFirstTime = this.context.consumeFirstLoadMarker();
    const rolledBackVersion = this.context.rolledBackVersion();
    const uuid = this.context.getKv('uuid');
    const isUsingBundleUrl = this.context.getIsUsingBundleUrl();

    if (rolledBackVersion) {
      this.context.clearRollbackMark();
    }

    const result = {
      downloadRootDir: `${this.mUiCtx.filesDir}/_update`,
      currentVersionInfo,
      currentBundleSha256,
      packageVersion,
      currentVersion,
      buildTime,
      isUsingBundleUrl,
      isFirstTime,
      rolledBackVersion,
      uuid,
      supportedDiffVersion: NativePatchCore.getSupportedDiffVersion(),
    };
    const logResult = {
      downloadRootDir: result.downloadRootDir,
      currentVersionInfo: result.currentVersionInfo,
      packageVersion: result.packageVersion,
      currentVersion: result.currentVersion,
      buildTime: result.buildTime,
      isUsingBundleUrl: result.isUsingBundleUrl,
      isFirstTime: result.isFirstTime,
      rolledBackVersion: result.rolledBackVersion,
      uuidSet: !!result.uuid,
    };
    logger.info(TAG, `,getConstants result: ${JSON.stringify(logResult)}`);
    return result;
  }

  // 以下方法在 JS spec(src/NativePushy.ts)里都返回 Promise,C++ 方法表
  // (PushyTurboModule.cpp)相应用 PUSHY_ASYNC_METHOD 注册:同步注册会把
  // ArkTS 的 Promise 变成空对象、把 reject 丢成 ArkTS 侧的 unhandled rejection。
  // 每个拒绝都带稳定错误码(ErrorCodes.ts):`code` 属性 + `[CODE] ` 消息前缀。

  async setLocalHashInfo(hash: string, info: string): Promise<void> {
    logger.debug(TAG, ',call setLocalHashInfo');
    this.requireHash(hash, 'setLocalHashInfo');
    validateHashInfo(info);
    try {
      await this.context.setKv(`hash_${hash}`, info);
    } catch (error) {
      throw toUpdateError(error, ERROR_FILE_OPERATION_FAILED);
    }
  }

  async getLocalHashInfo(hash: string): Promise<string> {
    this.requireHash(hash, 'getLocalHashInfo');
    const value = this.context.getKv(`hash_${hash}`);
    validateHashInfo(value);
    return value;
  }

  async setUuid(uuid: string): Promise<void> {
    logger.debug(TAG, ',call setUuid');
    try {
      await this.context.setKv('uuid', uuid);
    } catch (error) {
      throw toUpdateError(error, ERROR_FILE_OPERATION_FAILED);
    }
  }

  // Provisioning for the native cold-start update check
  // (NATIVE_CHECKUPDATE_DESIGN §10.1): the raw JSON persists as-is, parsed on
  // read by the orchestrator; absent config = check disabled. Validated at
  // write time — a corrupt config would otherwise silently disable the
  // native check forever with no signal.
  async syncNativeConfig(config: string): Promise<void> {
    logger.debug(TAG, ',call syncNativeConfig');
    try {
      JSON.parse(config);
    } catch (e) {
      throw createUpdateError(
        ERROR_INVALID_OPTIONS,
        `syncNativeConfig: config is not valid JSON: ${getErrorMessage(e)}`,
      );
    }
    try {
      await this.context.setKv(KEY_CONFIG, config);
    } catch (error) {
      throw toUpdateError(error, ERROR_FILE_OPERATION_FAILED);
    }
  }

  // JS 本进程已拿到有效检查响应:延迟的原生轮次据此跳过重复请求(§10.3)。
  async markJsCheckCompleted(config: string): Promise<void> {
    logger.debug(TAG, ',call markJsCheckCompleted');
    if (typeof config !== 'string' || config.length === 0) {
      throw createUpdateError(
        ERROR_INVALID_OPTIONS,
        'config must be a non-empty string',
      );
    }
    markJsCheckCompleted(config);
  }

  // 原生冷启动检测落盘的原始响应缓存,JS 侧新鲜期内直接复用免二次请求
  // (NATIVE_CHECKUPDATE_DESIGN §10.3)。缺省空串,永不 reject。
  async getNativeCheckCache(): Promise<string> {
    logger.debug(TAG, ',call getNativeCheckCache');
    return this.context.getKv(KEY_RESP_CACHE) ?? '';
  }

  async reloadUpdate(options: { hash: string }): Promise<void> {
    logger.debug(TAG, ',call reloadUpdate');
    const hash = this.requireHash(options.hash, 'reloadUpdate');

    // 切换必须真正落盘(switchVersion 内 await flush)后才重启:重启会立刻
    // 杀进程,未落盘的切换就是"重启回旧 bundle"。
    try {
      await this.context.switchVersion(hash);
    } catch (error) {
      logger.error(TAG, `reloadUpdate switch failed: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_SWITCH_VERSION_FAILED);
    }
    try {
      await this.reloadBridge();
    } catch (error) {
      logger.error(TAG, `reloadUpdate restart failed: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_RESTART_FAILED);
    }
  }

  async restartApp(): Promise<void> {
    logger.debug(TAG, ',call restartApp');
    try {
      await this.reloadBridge();
    } catch (error) {
      logger.error(TAG, `restartApp failed: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_RESTART_FAILED);
    }
  }

  async setNeedUpdate(options: { hash: string }): Promise<void> {
    logger.debug(TAG, ',call setNeedUpdate');
    const hash = this.requireHash(options.hash, 'setNeedUpdate');

    try {
      await this.context.switchVersion(hash);
    } catch (error) {
      logger.error(TAG, `setNeedUpdate failed: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_SWITCH_VERSION_FAILED);
    }
  }

  async markSuccess(): Promise<void> {
    logger.debug(TAG, ',call markSuccess');
    try {
      await this.context.markSuccess();
    } catch (error) {
      logger.error(TAG, `markSuccess failed: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_MARK_SUCCESS_FAILED);
    }
  }

  async getBundleHash(): Promise<string> {
    logger.debug(TAG, ',call getBundleHash');
    try {
      return await this.context.getBundleHash();
    } catch (error) {
      // 空串 = "未知",服务端回退 buildTime 启发式;该方法永不 reject。
      logger.error(TAG, `getBundleHash failed: ${getErrorMessage(error)}`);
      return '';
    }
  }

  async resetToPackagedBundle(): Promise<void> {
    logger.debug(TAG, ',call resetToPackagedBundle');
    try {
      await this.context.resetToPackagedBundle();
    } catch (error) {
      logger.error(TAG, `resetToPackagedBundle failed: ${getErrorMessage(error)}`);
      throw toUpdateError(error, ERROR_RESET_FAILED);
    }
  }

  async downloadPatchFromPpk(options: {
    updateUrl: string;
    hash: string;
    originHash: string;
  }): Promise<void> {
    logger.debug(TAG, ',call downloadPatchFromPpk');
    return this.context.downloadPatchFromPpk(
      options.updateUrl,
      options.hash,
      options.originHash,
    );
  }

  async downloadPatchFromPackage(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void> {
    logger.debug(TAG, ',call downloadPatchFromPackage');
    return this.context.downloadPatchFromPackage(
      options.updateUrl,
      options.hash,
    );
  }

  async downloadFullUpdate(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void> {
    logger.debug(TAG, ',call downloadFullUpdate');
    return this.context.downloadFullUpdate(options.updateUrl, options.hash);
  }

  async downloadAndInstallApk(_options: {
    url: string;
    target: string;
    hash: string;
  }): Promise<void> {
    logger.debug(TAG, ',call downloadAndInstallApk');
    throw createUpdateError(
      ERROR_UNSUPPORTED_PLATFORM,
      'downloadAndInstallApk is only supported on Android',
    );
  }

  addListener(_eventName: string): void {
    logger.debug(TAG, ',call addListener');
  }

  removeListeners(_count: number): void {
    logger.debug(TAG, ',call removeListeners');
  }
}
