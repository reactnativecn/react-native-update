import {
  FileJSBundle,
  HotReloadConfig,
  JSBundleProvider,
  JSBundleProviderError
} from '@rnoh/react-native-openharmony';
import common from '@ohos.app.ability.common';
import fs from '@ohos.file.fs';
import { UpdateContext } from './UpdateContext';

export class PushyFileJSBundleProvider extends JSBundleProvider {
  private updateContext: UpdateContext;
  private path: string = ''

  constructor(context: common.UIAbilityContext) {
    super();
    this.updateContext = new UpdateContext(context);
    this.path = this.updateContext.getBundleUrl();
  }

  getURL(): string {
    return this.path;
  }

  async getBundle(): Promise<FileJSBundle> {
    try {
      const status = await fs.access(this.path, fs.OpenMode.READ_ONLY);
      if (status) {
        return {
          filePath: this.path
        }
      }
      throw new Error('Update bundle not found');
    } catch (error) {
      throw new JSBundleProviderError({
        whatHappened: `Couldn't load JSBundle from ${this.path}`,
        extraData: error,
        howCanItBeFixed: [`Check if a bundle exists at "${this.path}" on your device.`]
      })
    }
  }

  getAppKeys(): string[] {
    return [];
  }
}