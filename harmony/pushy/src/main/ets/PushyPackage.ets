import {
  RNOHPackage,
} from '@rnoh/react-native-openharmony';
import { createPushyTurboModuleFactoryMap } from './PushyPackageFactory';

export class PushyPackage extends RNOHPackage {
  override getUITurboModuleFactoryByNameMap() {
    return createPushyTurboModuleFactoryMap();
  }
}
