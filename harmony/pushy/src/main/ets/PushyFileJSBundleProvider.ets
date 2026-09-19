import {
  FileJSBundle,
  JSBundleProvider,
  JSBundleProviderError,
} from '@rnoh/react-native-openharmony';
import common from '@ohos.app.ability.common';
import fs from '@ohos.file.fs';
import { UpdateContext } from './UpdateContext';
import { checkAndUpdateNative } from './NativeCheckOrchestrator';
import type { NativeUpdateResult } from './NativeUpdateResult';
import { normalizeNativeUpdateConfig } from './NativeUpdateConfig';
import type { NativeUpdateConfig } from './NativeUpdateConfig';

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
  async configure(options: NativeUpdateConfig): Promise<void> {
    const config = normalizeNativeUpdateConfig(options);
    await this.updateContext.setNativeConfig(config);
  }

  /** Call after the host's real bundle resolution; never resolves it again. */
  checkAndUpdate(): Promise<NativeUpdateResult> {
    return checkAndUpdateNative(this.updateContext);
  }

  getAppKeys(): string[] {
    return [];
  }
}
