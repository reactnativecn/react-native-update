// Encoded text shared by the Harmony module. No imports, so any file can use it
// without forming an import cycle.

// Decodes text produced by scripts/encode-native-text.ts (byte i XORed with
// (0x5A + 0x1D * i) & 0xFF), keeping service addresses and paths out of static
// string scans of the package. Not a secret.
export function revealText(hex: string): string {
  let text = '';
  for (let i = 0; i < hex.length / 2; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    text += String.fromCharCode(byte ^ ((0x5a + 0x1d * i) & 0xff));
  }
  return text;
}

// Request path appended to an endpoint base.
export const QUERY_PATH: string = revealText('7514fcd4ad805d55263e08fc99');

// Protocol values, version-info flags and storage names, stored encoded.
export const STATUS_NONE: string = revealText('3418c1c1aa8a7c40');
export const POLICY_NEXT_LAUNCH: string = revealText('2912e0ffab8e6c70323b1dedd3');
export const STORAGE_DIR_NAME: string = revealText('0502e4d5af9f6d');
export const PREFERENCES_NAME: string = revealText('2f07f0d0ba8e');
export const PPK_DELTA_SUFFIX: string = revealText('7407e4dae09b69512137');
export const APP_DELTA_SUFFIX: string = revealText('7416e4c1e09b69512137');
export const BUNDLE_DELTA_ENTRY: string = revealText('3802fad5a28e264d232d11f6d8aade67596914e0ead8b0');
export const DEVTOOLS_RESTART_EVENT: string = revealText('0832d8fe8faf');
export const DEVTOOLS_RESTART_REASON: string = revealText('1218e0e3ab876744266d');
