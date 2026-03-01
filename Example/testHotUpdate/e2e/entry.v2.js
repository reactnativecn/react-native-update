const { LOCAL_UPDATE_LABELS } = require('./localUpdateConfig');

global.__RNU_E2E_BUNDLE_LABEL = LOCAL_UPDATE_LABELS.ppkPatch;
require('../index');
