// Keep in sync with Example/e2etest/e2e/localUpdateConfig.ts (the e2etest app
// is RN 0.85 which RNOH does not support yet, so the harmony e2e app lives in
// this RN 0.72 project and duplicates the shared constants).
export const LOCAL_UPDATE_PORT = 31337;

export const LOCAL_UPDATE_APP_KEY = 'local-e2e-harmony';

export const LOCAL_UPDATE_LABELS = {
  base: 'BINARY_BASE',
  full: 'E2E_FULL_V1',
  ppkPatch: 'E2E_PPK_PATCH_V2',
  v2Track: 'E2E_V2TRACK_V4',
} as const;

// The device reaches the host through `hdc rport tcp:31337 tcp:31337`.
export function getLocalUpdateEndpoint() {
  return `http://127.0.0.1:${LOCAL_UPDATE_PORT}`;
}
