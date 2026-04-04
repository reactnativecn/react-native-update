import {
  RNPackage,
} from '@rnoh/react-native-openharmony/ts';
import { createPushyTurboModuleFactoryMap } from './PushyPackageFactory';

export class PushyPackage extends RNPackage {
  override getUITurboModuleFactoryByNameMap() {
    return createPushyTurboModuleFactoryMap();
  }
}
