import {
  UITurboModule,
  UITurboModuleContext,
} from '@rnoh/react-native-openharmony/ts';
import { PushyTurboModule } from './PushyTurboModule';

export function createPushyTurboModuleFactoryMap(): Map<
  string,
  (ctx: UITurboModuleContext) => UITurboModule | null
> {
  return new Map<string, (ctx: UITurboModuleContext) => UITurboModule | null>([
    [PushyTurboModule.NAME, (ctx) => new PushyTurboModule(ctx)],
  ]);
}
