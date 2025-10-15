import { HotReloadConfig, JSBundleProvider, JSBundleProviderError, JSPackagerClientConfig } from '@rnoh/react-native-openharmony';
import fileIo from '@ohos.file.fs';
import common from '@ohos.app.ability.common';
import { UpdateContext } from './UpdateContext';

export class PushyFileJSBundleProvider extends JSBundleProvider {
  private updateContext: UpdateContext;
  private filePath: string = ''

  constructor(context: common.UIAbilityContext) {
    super();
    this.updateContext = new UpdateContext(context);
  }
  getURL(): string {
    return this.updateContext.getBundleUrl()?.substring(1);
  }

  async getBundle(): Promise<ArrayBuffer> {
    try {
      this.filePath =  this.updateContext.getBundleUrl();
      const res = fileIo.accessSync(this.filePath);
      if (res) {
        const file = fileIo.openSync(this.filePath, fileIo.OpenMode.READ_ONLY);
        try {
          const stat = await fileIo.stat(this.filePath);
          const fileSize = stat.size;
          const buffer = new ArrayBuffer(fileSize);
          const bytesRead = fileIo.readSync(file.fd, buffer, {
            offset: 0,
            length: fileSize
          });
          
          if (bytesRead !== fileSize) {
            throw new Error(`Failed to read entire file: read ${bytesRead} of ${fileSize} bytes`);
          }
          return buffer;
        } finally {
          fileIo.closeSync(file.fd);
        }
      }
      throw new Error('Update bundle not found');
    } catch (error) {
      throw new JSBundleProviderError({
        whatHappened: `Couldn't load JSBundle from ${this.filePath}`,
        extraData: error,
        howCanItBeFixed: [`Check if a bundle exists at "${this.filePath}" on your device.`]
      })
    }
  }

  getAppKeys(): string[] {
    return [];
  }
}