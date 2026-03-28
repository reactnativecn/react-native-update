import {
  RNPackage,
  UITurboModule,
  UITurboModuleContext,
} from '@rnoh/react-native-openharmony/ts';
import { PushyTurboModule } from './PushyTurboModule';

export class PushyPackage extends RNPackage {
  override getUITurboModuleFactoryByNameMap(): Map<
    string,
    (ctx: UITurboModuleContext) => UITurboModule | null
  > {
    return new Map<string, (ctx: UITurboModuleContext) => UITurboModule>()
      .set(PushyTurboModule.NAME, (ctx) => new PushyTurboModule(ctx));
  }
}
