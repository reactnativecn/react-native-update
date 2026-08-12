// §11 Harmony crash-semantics probe (not part of the regular e2e suites):
// does an uncaught JS error in release kill the whole process (the
// Android/iOS behaviour the crash rescue exists for), or does RNOH survive
// it? Thrown at +1s — before the native check's 5s delay — so a surviving
// process also proves the orchestrator round outlives JS death.
import { AppRegistry } from 'react-native';
import { name as appName } from '../app.json';
import App from './app';

setTimeout(() => {
  throw new Error('HM_CRASH_PROBE: uncaught JS error at +1s');
}, 1000);

AppRegistry.registerComponent(appName, () => App);
