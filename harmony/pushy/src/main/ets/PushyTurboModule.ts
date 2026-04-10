import {
  UITurboModule,
  UITurboModuleContext,
} from '@rnoh/react-native-openharmony/ts';
import common from '@ohos.app.ability.common';
import { bundleManager } from '@kit.AbilityKit';
import logger from './Logger';
import { UpdateContext } from './UpdateContext';
import { EventHub } from './EventHub';
import { util } from '@kit.ArkTS';

const TAG = 'PushyTurboModule';

export class PushyTurboModule extends UITurboModule {
  public static readonly NAME = 'Pushy';

  mUiCtx: common.UIAbilityContext;
  context: UpdateContext;

  constructor(protected ctx: UITurboModuleContext) {
    super(ctx);
    logger.debug(TAG, ',PushyTurboModule constructor');
    this.mUiCtx = ctx.uiAbilityContext;
    this.context = new UpdateContext(this.mUiCtx);
    EventHub.getInstance().setRNInstance(ctx.rnInstance);
  }

  private getBundleFlags(): bundleManager.BundleFlag {
    return bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
  }

  private getErrorMessage(error: any): string {
    if (error && typeof error === 'object' && 'message' in error) {
      return String(error.message);
    }
    return String(error);
  }

  private getPackageVersion(): string {
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(
        this.getBundleFlags(),
      );
      return bundleInfo?.versionName || 'Unknown';
    } catch (error) {
      console.error('Failed to get bundle info:', error);
      return '';
    }
  }

  private getBuildTime(): string {
    try {
      const content = this.mUiCtx.resourceManager.getRawFileContentSync(
        'meta.json',
      );
      const metaData = JSON.parse(
        new util.TextDecoder().decodeToString(content),
      ) as Record<string, string | number | boolean | null | undefined>;
      if (metaData.pushy_build_time) {
        return String(metaData.pushy_build_time);
      }
    } catch {}
    return '';
  }

  private requireHash(hash: string, methodName: string): string {
    if (!hash) {
      throw Error(`${methodName}: empty hash`);
    }
    return hash;
  }

  private validateHashInfo(info: string): void {
    try {
      const parsed = JSON.parse(info);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw Error('invalid json string');
      }
    } catch {
      throw Error('invalid json string');
    }
  }

  private async restartAbility(): Promise<void> {
    const bundleInfo = await bundleManager.getBundleInfoForSelf(
      this.getBundleFlags(),
    );
    const want = {
      bundleName: bundleInfo.name,
      abilityName: this.mUiCtx.abilityInfo?.name,
    };
    await this.mUiCtx.terminateSelf();
    await this.mUiCtx.startAbility(want);
  }

  getConstants(): Object {
    logger.debug(TAG, ',call getConstants');
    const packageVersion = this.getPackageVersion();
    const buildTime = this.getBuildTime();
    this.context.syncStateWithBinaryVersion(packageVersion, buildTime);

    const currentVersion = this.context.getCurrentVersion();
    const bundleHash = this.context.getBundleHash(packageVersion, buildTime);
    const currentVersionInfo = currentVersion
      ? this.context.getKv(`hash_${currentVersion}`)
      : '';
    const isFirstTime = this.context.isFirstTime();
    const rolledBackVersion = this.context.rolledBackVersion();
    const uuid = this.context.getKv('uuid');
    const isUsingBundleUrl = this.context.getIsUsingBundleUrl();

    if (rolledBackVersion) {
      this.context.clearRollbackMark();
    }

    return {
      downloadRootDir: `${this.mUiCtx.filesDir}/_update`,
      currentVersionInfo,
      packageVersion,
      currentVersion,
      buildTime,
      bundleHash,
      isUsingBundleUrl,
      isFirstTime,
      rolledBackVersion,
      uuid,
    };
  }

  setLocalHashInfo(hash: string, info: string): boolean {
    logger.debug(TAG, ',call setLocalHashInfo');
    this.validateHashInfo(info);
    this.context.setKv(`hash_${hash}`, info);
    return true;
  }

  getLocalHashInfo(hash: string): string {
    const value = this.context.getKv(`hash_${hash}`);
    this.validateHashInfo(value);
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
      await this.restartAbility();
    } catch (error) {
      logger.error(TAG, `reloadUpdate failed: ${this.getErrorMessage(error)}`);
      throw Error(`switchVersion failed ${this.getErrorMessage(error)}`);
    }
  }

  async restartApp(): Promise<void> {
    logger.debug(TAG, ',call restartApp');
    try {
      await this.restartAbility();
    } catch (error) {
      logger.error(TAG, `restartApp failed: ${this.getErrorMessage(error)}`);
      throw Error(`restartApp failed ${this.getErrorMessage(error)}`);
    }
  }

  async setNeedUpdate(options: { hash: string }): Promise<boolean> {
    logger.debug(TAG, ',call setNeedUpdate');
    const hash = this.requireHash(options.hash, 'setNeedUpdate');

    try {
      this.context.switchVersion(hash);
      return true;
    } catch (error) {
      logger.error(TAG, `setNeedUpdate failed: ${this.getErrorMessage(error)}`);
      throw Error(`switchVersionLater failed: ${this.getErrorMessage(error)}`);
    }
  }

  async markSuccess(): Promise<boolean> {
    logger.debug(TAG, ',call markSuccess');
    try {
      this.context.markSuccess();
      return true;
    } catch (error) {
      logger.error(TAG, `markSuccess failed: ${this.getErrorMessage(error)}`);
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
