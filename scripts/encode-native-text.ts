#!/usr/bin/env bun
// Encodes ASCII text for the native "reveal" helpers so service addresses and
// request paths are not stored as plain strings in shipped binaries:
//   Android  HttpUtils.reveal(hex)
//   iOS      RCTPushyRevealText(hex)
//   Harmony  revealText(hex)
// Byte i is XORed with (0x5A + 0x1D * i) & 0xFF and written as two hex digits.
// This only keeps the text out of static string scans; it is not a secret.
//
// Usage: bun scripts/encode-native-text.ts "https://example.com/api" ...

export const encodeNativeText = (text: string): string => {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new Error(`only ASCII text is supported: ${JSON.stringify(text)}`);
    }
    const byte = code ^ ((0x5a + 0x1d * i) & 0xff);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
};

export const decodeNativeText = (hex: string): string => {
  let text = '';
  for (let i = 0; i < hex.length / 2; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    text += String.fromCharCode(byte ^ ((0x5a + 0x1d * i) & 0xff));
  }
  return text;
};

if (import.meta.main) {
  for (const text of process.argv.slice(2)) {
    console.log(`${encodeNativeText(text)}  // ${text}`);
  }
}
