export const LOCAL_UPDATE_PORT = 31337;

export const LOCAL_UPDATE_APP_KEYS = {
  ios: 'local-e2e-ios',
  android: 'local-e2e-android',
  // The harmony e2e app lives in Example/harmony_use_pushy (RN 0.72, the
  // newest RN that RNOH supports); keep its copy of these constants in sync:
  // Example/harmony_use_pushy/e2e/localUpdateConfig.ts
  harmony: 'local-e2e-harmony',
} as const;

export const LOCAL_UPDATE_HASHES = {
  full: 'e2e-full-v1',
  ppkPatch: 'e2e-ppk-patch-v2',
  packagePatch: 'e2e-package-patch-v3',
  v2Track: 'e2e-v2track-v4',
} as const;

export const LOCAL_UPDATE_LABELS = {
  base: 'BINARY_BASE',
  full: 'E2E_FULL_V1',
  ppkPatch: 'E2E_PPK_PATCH_V2',
  packagePatch: 'E2E_PACKAGE_PATCH_V3',
  v2Track: 'E2E_V2TRACK_V4',
} as const;

export const LOCAL_UPDATE_FILES = {
  full: 'v1.ppk',
  ppkFull: 'v2.ppk',
  ppkDiff: 'v1-to-v2.ppk.patch',
  packageFull: 'v3.ppk',
  packageDiff: 'base-to-v3.apk.patch',
  v2TrackFull: 'v4.ppk',
  v2TrackDiff: 'to-v4.v2track.ppk.patch',
  apk: 'app-release.apk',
} as const;

export type LocalUpdatePlatform = keyof typeof LOCAL_UPDATE_APP_KEYS;

export const LOCAL_UPDATE_FINAL_STATE = {
  android: {
    label: LOCAL_UPDATE_LABELS.v2Track,
    hash: LOCAL_UPDATE_HASHES.v2Track,
  },
  ios: {
    label: LOCAL_UPDATE_LABELS.v2Track,
    hash: LOCAL_UPDATE_HASHES.v2Track,
  },
  harmony: {
    label: LOCAL_UPDATE_LABELS.v2Track,
    hash: LOCAL_UPDATE_HASHES.v2Track,
  },
  default: {
    label: LOCAL_UPDATE_LABELS.ppkPatch,
    hash: LOCAL_UPDATE_HASHES.ppkPatch,
  },
} as const satisfies Record<
  LocalUpdatePlatform | 'default',
  { label: string; hash: string }
>;

export function getLocalUpdateHost(platform: string) {
  return platform === 'android' ? '10.0.2.2' : '127.0.0.1';
}

export function getLocalUpdateEndpoint(platform: string) {
  return `http://${getLocalUpdateHost(platform)}:${LOCAL_UPDATE_PORT}`;
}
