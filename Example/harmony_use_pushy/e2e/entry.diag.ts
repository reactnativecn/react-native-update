// Diagnostic entry: why does syncNativeConfig never run on RNOH?
import { AppRegistry } from 'react-native';
import { PushyModule } from 'react-native-update';
import { name as appName } from '../app.json';
import App from './app';

const mod = PushyModule as unknown as Record<string, unknown>;
console.error(
  `RNU_DIAG typeof syncNativeConfig=${typeof mod.syncNativeConfig} ` +
    `typeof getConstants=${typeof mod.getConstants} ` +
    `keys=${JSON.stringify(Object.keys(mod)).slice(0, 300)}`
);
Promise.resolve()
  .then(() => (mod.syncNativeConfig as (c: string) => Promise<void>)('{"probe":true}'))
  .then(() => console.error('RNU_DIAG direct syncNativeConfig call OK'))
  .catch((e: Error) => console.error(`RNU_DIAG direct call failed: ${e.message}`));

AppRegistry.registerComponent(appName, () => App);
