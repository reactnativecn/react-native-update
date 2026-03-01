const LOCAL_UPDATE_PORT = 31337;

const LOCAL_UPDATE_HASHES = {
  full: 'e2e-full-v1',
  ppkPatch: 'e2e-ppk-patch-v2',
  packagePatch: 'e2e-package-patch-v3',
};

const LOCAL_UPDATE_LABELS = {
  base: 'BINARY_BASE',
  full: 'E2E_FULL_V1',
  ppkPatch: 'E2E_PPK_PATCH_V2',
  packagePatch: 'E2E_PACKAGE_PATCH_V3',
};

const LOCAL_UPDATE_FILES = {
  full: 'v1.ppk',
  ppkDiff: 'v1-to-v2.ppk.patch',
  packageDiff: 'base-to-v3.apk.patch',
  apk: 'app-release.apk',
};

module.exports = {
  LOCAL_UPDATE_PORT,
  LOCAL_UPDATE_HASHES,
  LOCAL_UPDATE_LABELS,
  LOCAL_UPDATE_FILES,
};
