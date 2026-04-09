export const LOCAL_UPDATE_PORT = 31337;

export const LOCAL_UPDATE_APP_KEYS = {
  ios: 'local-e2e-ios',
  android: 'local-e2e-android',
} as const;

export const LOCAL_UPDATE_HASHES = {
  full: 'e2e-full-v1',
  ppkPatch: 'e2e-ppk-patch-v2',
  packagePatch: 'e2e-package-patch-v3',
} as const;

export const LOCAL_UPDATE_LABELS = {
  base: 'BINARY_BASE',
  full: 'E2E_FULL_V1',
  ppkPatch: 'E2E_PPK_PATCH_V2',
  packagePatch: 'E2E_PACKAGE_PATCH_V3',
} as const;

export const LOCAL_UPDATE_FILES = {
  full: 'v1.ppk',
  ppkDiff: 'v1-to-v2.ppk.patch',
  packageDiff: 'base-to-v3.apk.patch',
  apk: 'app-release.apk',
} as const;

export type LocalUpdatePlatform = keyof typeof LOCAL_UPDATE_APP_KEYS;

export function getLocalUpdateHost(platform: string) {
  return platform === 'android' ? '10.0.2.2' : '127.0.0.1';
}

export function getLocalUpdateEndpoint(platform: string) {
  return `http://${getLocalUpdateHost(platform)}:${LOCAL_UPDATE_PORT}`;
}
