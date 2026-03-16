import {
  TurboModule,
  TurboModuleContext,
} from '@rnoh/react-native-openharmony/ts';
import common from '@ohos.app.ability.common';
import logger from './Logger';
import { UpdateModuleImpl } from './UpdateModuleImpl';
import { UpdateContext } from './UpdateContext';
import { EventHub } from './EventHub';

const TAG = 'PushyTurboModule';

export class PushyTurboModule extends TurboModule {
  mUiCtx: common.UIAbilityContext;
  context: UpdateContext;

  constructor(protected ctx: TurboModuleContext) {
    super(ctx);
    logger.debug(TAG, ',PushyTurboModule constructor');
    this.mUiCtx = ctx.uiAbilityContext;
    this.context = UpdateContext.getInstance(this.mUiCtx);
    EventHub.getInstance().setRNInstance(ctx.rnInstance);
  }

  getConstants(): Object {
    logger.debug(TAG, ',call getConstants');
    const { isFirstTime, rolledBackVersion } =
      this.context.consumeLaunchMarks();
    const uuid = this.context.getKv('uuid');
    const currentVersion = this.context.getCurrentVersion();
    const currentVersionInfo = this.context.getKv(`hash_${currentVersion}`);

    return {
      downloadRootDir: this.context.getRootDir(),
      currentVersionInfo,
      packageVersion: this.context.getPackageVersion(),
      currentVersion,
      buildTime: this.context.getBuildTime(),
      isUsingBundleUrl: this.context.getIsUsingBundleUrl(),
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
