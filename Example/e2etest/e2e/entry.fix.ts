// §11 crash-rescue experiment fix bundle: disarm the brick flag immediately.
import { PushyModule } from 'react-native-update';
import { LOCAL_UPDATE_LABELS } from './localUpdateConfig.ts';

const bundleLabelGlobal = globalThis as typeof globalThis & {
  __RNU_E2E_BUNDLE_LABEL?: string;
};

bundleLabelGlobal.__RNU_E2E_BUNDLE_LABEL = `${LOCAL_UPDATE_LABELS.base}_FIXED`;

PushyModule.setLocalHashInfo(
  'brickflag',
  JSON.stringify({ state: 'disarmed' })
);

require('../index');
