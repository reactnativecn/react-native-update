import {
  FileJSBundle,
  JSBundleProvider,
  JSBundleProviderError,
} from '@rnoh/react-native-openharmony';
import common from '@ohos.app.ability.common';
import fs from '@ohos.file.fs';
import { UpdateContext } from './UpdateContext';
import { prepareBundleNative } from './NativeCheckOrchestrator';
import type { BundlePreparationResult } from './BundlePreparationResult';
import { normalizePushyConfiguration } from './PushyConfiguration';
import type { PushyConfiguration } from './PushyConfiguration';

export class PushyFileJSBundleProvider extends JSBundleProvider {
  private updateContext: UpdateContext;

  constructor(context: common.UIAbilityContext) {
    super();
    this.updateContext = UpdateContext.getInstance(context);
  }

  getURL(): string {
    return this.updateContext.getBundleUrl();
  }

  async getBundle(): Promise<FileJSBundle> {
    const path = this.updateContext.getBundleUrl();
    if (!path) {
      throw new JSBundleProviderError({
        whatHappened: 'No pushy bundle found. using default bundle',
        howCanItBeFixed: [''],
      });
    }
    try {
      await fs.access(path, fs.OpenMode.READ_ONLY);
      return {
        filePath: path,
      };
    } catch (error) {
      throw new JSBundleProviderError({
        whatHappened: `Couldn't load JSBundle from ${path}`,
        extraData: error,
        howCanItBeFixed: [
          `Check if a bundle exists at "${path}" on your device.`,
        ],
      });
    }
  }

  /** Configure before normal bundle resolution; no JS or network work is required. */
  async configure(options: PushyConfiguration): Promise<void> {
    const config = normalizePushyConfiguration(options);
    await this.updateContext.setNativeConfig(config);
  }

  /** Call after the host's real bundle resolution; never resolves it again. */
  prepareBundle(): Promise<BundlePreparationResult> {
    return prepareBundleNative(this.updateContext);
  }

  getAppKeys(): string[] {
    return [];
  }
}
