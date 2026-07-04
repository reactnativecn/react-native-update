import {
  UITurboModule,
  UITurboModuleContext,
} from '@rnoh/react-native-openharmony/ts';
import common from '@ohos.app.ability.common';
import { bundleManager } from '@kit.AbilityKit';
import logger from './Logger';
import { UpdateContext } from './UpdateContext';
import { EventHub } from './EventHub';

const TAG = 'PushyTurboModule';

export function getErrorMessage(error: any): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

export function validateHashInfo(info: string): void {
  try {
    const parsed = JSON.parse(info);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Error('invalid json string');
    }
  } catch {
    throw Error('invalid json string');
  }
}

export class PushyTurboModule extends UITurboModule {
  public static readonly NAME = 'Pushy';

  mUiCtx: common.UIAbilityContext;
  context: UpdateContext;

  constructor(protected ctx: UITurboModuleContext) {
    super(ctx);
    logger.debug(TAG, ',PushyTurboModule constructor');
    this.mUiCtx = ctx.uiAbilityContext;
    this.context = UpdateContext.getInstance(this.mUiCtx);
    EventHub.getInstance().setRNInstance(ctx.rnInstance);
  }

  private getBundleFlags(): bundleManager.BundleFlag {
    return bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
  }

  private requireHash(hash: string, methodName: string): string {
    if (!hash) {
      throw Error(`${methodName}: empty hash`);
    }
    return hash;
  }

  private async restartAbility(): Promise<void> {
    const bundleInfo = await bundleManager.getBundleInfoForSelf(
      this.getBundleFlags(),
    );
    const want = {
      bundleName: bundleInfo.name,
      abilityName: this.mUiCtx.abilityInfo?.name,
    };
    try {
      const applicationContext = this.mUiCtx.getApplicationContext();
      if (applicationContext && typeof (applicationContext as any).restartApp === 'function') {
        logger.debug(TAG, 'restartAbility via applicationContext.restartApp');
        (applicationContext as any).restartApp(want);
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
      const devToolsController = (this.ctx as Record<string, any>).devToolsController;
      if (devToolsController) {
        devToolsController.eventEmitter.emit("RELOAD", { reason: 'HotReload2' });
      }
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
        const devToolsController = (this.ctx as Record<string, any>).devToolsController;
        if (devToolsController) {
          devToolsController.eventEmitter.emit("RELOAD", { reason: 'HotReload2' });
        }
      }, 1500);

      try {
        await this.restartAbility();
      } catch (error) {
        clearTimeout(fallbackTimer);
        logger.error(TAG, `restartAbility failed: ${getErrorMessage(error)}, triggering soft reload fallback`);
        const devToolsController = (this.ctx as Record<string, any>).devToolsController;
        if (devToolsController) {
          devToolsController.eventEmitter.emit("RELOAD", { reason: 'HotReload2' });
        }
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
      packageVersion,
      currentVersion,
      buildTime,
      isUsingBundleUrl,
      isFirstTime,
      rolledBackVersion,
      uuid,
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

  setLocalHashInfo(hash: string, info: string): boolean {
    logger.debug(TAG, ',call setLocalHashInfo');
    validateHashInfo(info);
    this.context.setKv(`hash_${hash}`, info);
    return true;
  }

  getLocalHashInfo(hash: string): string {
    const value = this.context.getKv(`hash_${hash}`);
    validateHashInfo(value);
    return value;
  }

  async setUuid(uuid: string): Promise<void> {
    logger.debug(TAG, ',call setUuid');
    this.context.setKv('uuid', uuid);
  }

  async reloadUpdate(options: { hash: string }): Promise<void> {
    logger.debug(TAG, ',call reloadUpdate');
    const hash = this.requireHash(options.hash, 'reloadUpdate');

    try {
      this.context.switchVersion(hash);
      await this.reloadBridge();
    } catch (error) {
      logger.error(TAG, `reloadUpdate failed: ${getErrorMessage(error)}`);
      throw Error(`switchVersion failed ${getErrorMessage(error)}`);
    }
  }

  async restartApp(): Promise<void> {
    logger.debug(TAG, ',call restartApp');
    try {
      await this.reloadBridge();
    } catch (error) {
      logger.error(TAG, `restartApp failed: ${getErrorMessage(error)}`);
      throw Error(`restartApp failed ${getErrorMessage(error)}`);
    }
  }

  async setNeedUpdate(options: { hash: string }): Promise<boolean> {
    logger.debug(TAG, ',call setNeedUpdate');
    const hash = this.requireHash(options.hash, 'setNeedUpdate');

    try {
      this.context.switchVersion(hash);
      return true;
    } catch (error) {
      logger.error(TAG, `setNeedUpdate failed: ${getErrorMessage(error)}`);
      throw Error(`switchVersionLater failed: ${getErrorMessage(error)}`);
    }
  }

  async markSuccess(): Promise<boolean> {
    logger.debug(TAG, ',call markSuccess');
    try {
      this.context.markSuccess();
      return true;
    } catch (error) {
      logger.error(TAG, `markSuccess failed: ${getErrorMessage(error)}`);
      throw error;
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
    throw Error('downloadAndInstallApk is only supported on Android');
  }

  addListener(_eventName: string): void {
    logger.debug(TAG, ',call addListener');
  }

  removeListeners(_count: number): void {
    logger.debug(TAG, ',call removeListeners');
  }
}
