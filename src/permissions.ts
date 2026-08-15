// RN >= 0.87 (generated types) no longer exports the `PermissionsAndroidStatic`
// interface, so derive the shape from the exported value instead — that spelling
// works on every RN version we support.
import type { PermissionsAndroid as RNPermissionsAndroid } from 'react-native';
import { emptyModule } from './utils';

export const PermissionsAndroid =
  emptyModule as unknown as typeof RNPermissionsAndroid;
