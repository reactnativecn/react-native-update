// §11 crash-rescue experiment (not part of the regular e2e suites): the first
// healthy launch arms a flag well after markSuccess; every later launch reads
// it and dies a few hundred ms in.
import { PushyModule } from 'react-native-update';
import { LOCAL_UPDATE_LABELS } from './localUpdateConfig.ts';

const bundleLabelGlobal = globalThis as typeof globalThis & {
  __RNU_E2E_BUNDLE_LABEL?: string;
};

bundleLabelGlobal.__RNU_E2E_BUNDLE_LABEL = `${LOCAL_UPDATE_LABELS.base}_BRICK`;

PushyModule.getLocalHashInfo('brickflag').then((v: string) => {
  if (v && v.includes('armed') && !v.includes('disarmed')) {
    setTimeout(() => {
      throw new Error('BRICK: crash on launch');
    }, 0);
  } else {
    setTimeout(() => {
      PushyModule.setLocalHashInfo(
        'brickflag',
        JSON.stringify({ state: 'armed' })
      );
      console.warn('brick armed for next launch');
    }, 8000);
  }
});

require('../index');
