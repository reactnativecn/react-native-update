import bundleManager from '@ohos.bundle.bundleManager';
import common from '@ohos.app.ability.common';
import { UpdateContext } from './UpdateContext';
import logger from './Logger';

const TAG = 'UpdateModuleImpl';

export class UpdateModuleImpl {
  static readonly NAME = 'Pushy';

  static async downloadFullUpdate(
    updateContext: UpdateContext,
    options: { updateUrl: string; hash: string },
  ): Promise<void> {
    return updateContext.downloadFullUpdate(options.updateUrl, options.hash);
  }

  static async downloadPatchFromPackage(
    updateContext: UpdateContext,
    options: { updateUrl: string; hash: string },
  ): Promise<void> {
    return updateContext.downloadPatchFromPackage(
      options.updateUrl,
      options.hash,
    );
  }

  static async downloadPatchFromPpk(
    updateContext: UpdateContext,
    options: { updateUrl: string; hash: string; originHash: string },
  ): Promise<void> {
    return updateContext.downloadPatchFromPpk(
      options.updateUrl,
      options.hash,
      options.originHash,
    );
  }

  static async reloadUpdate(
    updateContext: UpdateContext,
    context: common.UIAbilityContext,
    options: { hash: string },
  ): Promise<void> {
    const hash = options.hash;
    if (!hash) {
      throw Error('hash不能为空');
    }

    try {
      await updateContext.switchVersion(hash);
      const bundleInfo = await bundleManager.getBundleInfoForSelf(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION,
      );
      await context.terminateSelf();
      const want = {
        bundleName: bundleInfo.name,
        abilityName: context.abilityInfo?.name,
      };
      await context.startAbility(want);
    } catch (error) {
      logger.error(TAG, `reloadUpdate failed: ${error}`);
      throw Error(`switchVersion failed ${error.message}`);
    }
  }

  static async setNeedUpdate(
    updateContext: UpdateContext,
    options: { hash: string },
  ): Promise<boolean> {
    const hash = options.hash;
    if (!hash) {
      throw Error('empty hash');
    }

    try {
      await updateContext.switchVersion(hash);
      return true;
    } catch (error) {
      logger.error(TAG, `setNeedUpdate failed: ${error}`);
      throw Error(`switchVersionLater failed: ${error.message}`);
    }
  }

  static async markSuccess(updateContext: UpdateContext): Promise<boolean> {
    try {
      await updateContext.markSuccess();
      return true;
    } catch (error) {
      logger.error(TAG, `markSuccess failed: ${error}`);
      throw error;
    }
  }

  static async setUuid(
    updateContext: UpdateContext,
    uuid: string,
  ): Promise<void> {
    return updateContext.setKv('uuid', uuid);
  }

  static checkJson(json: string): boolean {
    try {
      JSON.parse(json);
      return true;
    } catch {
      return false;
    }
  }

  static setLocalHashInfo(
    updateContext: UpdateContext,
    hash: string,
    info: string,
  ): boolean {
    updateContext.setKv(`hash_${hash}`, info);
    return true;
  }

  static getLocalHashInfo(updateContext: UpdateContext, hash: string): string {
    const value = updateContext.getKv(`hash_${hash}`);
    return value;
  }
}
