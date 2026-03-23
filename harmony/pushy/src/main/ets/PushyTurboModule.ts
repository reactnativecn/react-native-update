import {
  TurboModule,
  TurboModuleContext,
} from '@rnoh/react-native-openharmony/ts';
import common from '@ohos.app.ability.common';
import { bundleManager } from '@kit.AbilityKit';
import logger from './Logger';
import { UpdateModuleImpl } from './UpdateModuleImpl';
import { UpdateContext } from './UpdateContext';
import { EventHub } from './EventHub';
import { util } from '@kit.ArkTS';

const TAG = 'PushyTurboModule';

export class PushyTurboModule extends TurboModule {
  mUiCtx: common.UIAbilityContext;
  context: UpdateContext;

  constructor(protected ctx: TurboModuleContext) {
    super(ctx);
    logger.debug(TAG, ',PushyTurboModule constructor');
    this.mUiCtx = ctx.uiAbilityContext;
    this.context = new UpdateContext(this.mUiCtx);
    EventHub.getInstance().setRNInstance(ctx.rnInstance);
  }

  getConstants(): Object {
    logger.debug(TAG, ',call getConstants');
    const context = this.mUiCtx;
    let bundleFlags =
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
    let packageVersion = '';
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleFlags);
      packageVersion = bundleInfo?.versionName || 'Unknown';
    } catch (error) {
      console.error('Failed to get bundle info:', error);
    }
    let buildTime = '';
    try {
      const resourceManager = this.mUiCtx.resourceManager;
      const content = resourceManager.getRawFileContentSync('meta.json');
      const metaData = JSON.parse(
        new util.TextDecoder().decodeToString(content),
      );
      if (metaData.pushy_build_time) {
        buildTime = String(metaData.pushy_build_time);
      }
    } catch {}
    this.context.syncStateWithBinaryVersion(packageVersion, buildTime);

    const currentVersion = this.context.getCurrentVersion();
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
      downloadRootDir: `${context.filesDir}/_update`,
      currentVersionInfo,
      packageVersion,
      currentVersion,
      buildTime,
      isUsingBundleUrl,
      isFirstTime,
      rolledBackVersion,
      uuid,
    };
  }

  setLocalHashInfo(hash: string, info: string): boolean {
    logger.debug(TAG, ',call setLocalHashInfo');
    return UpdateModuleImpl.setLocalHashInfo(this.context, hash, info);
  }

  getLocalHashInfo(hash: string): string {
    return UpdateModuleImpl.getLocalHashInfo(this.context, hash);
  }

  async setUuid(uuid: string): Promise<void> {
    logger.debug(TAG, ',call setUuid');
    return UpdateModuleImpl.setUuid(this.context, uuid);
  }

  async reloadUpdate(options: { hash: string }): Promise<void> {
    logger.debug(TAG, ',call reloadUpdate');
    return UpdateModuleImpl.reloadUpdate(this.context, this.mUiCtx, options);
  }

  async setNeedUpdate(options: { hash: string }): Promise<boolean> {
    logger.debug(TAG, ',call setNeedUpdate');
    return UpdateModuleImpl.setNeedUpdate(this.context, options);
  }

  async markSuccess(): Promise<boolean> {
    logger.debug(TAG, ',call markSuccess');
    return UpdateModuleImpl.markSuccess(this.context);
  }

  async downloadPatchFromPpk(options: {
    updateUrl: string;
    hash: string;
    originHash: string;
  }): Promise<void> {
    logger.debug(TAG, ',call downloadPatchFromPpk');
    return UpdateModuleImpl.downloadPatchFromPpk(this.context, options);
  }

  async downloadPatchFromPackage(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void> {
    logger.debug(TAG, ',call downloadPatchFromPackage');
    return UpdateModuleImpl.downloadPatchFromPackage(this.context, options);
  }

  async downloadFullUpdate(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void> {
    logger.debug(TAG, ',call downloadFullUpdate');
    return UpdateModuleImpl.downloadFullUpdate(this.context, options);
  }

  addListener(_eventName: string): void {
    logger.debug(TAG, ',call addListener');
  }

  removeListeners(_count: number): void {
    logger.debug(TAG, ',call removeListeners');
  }
}
