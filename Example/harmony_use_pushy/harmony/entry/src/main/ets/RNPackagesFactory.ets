import type { RNPackageContext, RNPackage } from '@rnoh/react-native-openharmony';
import PushyPackage from 'pushy';

export function createRNPackages(ctx: RNPackageContext): RNPackage[] {
  return [new PushyPackage(ctx)];
}
