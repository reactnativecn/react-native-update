import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  normalizePushyConfiguration,
  QUERY_PATH,
  revealText,
} from '../../harmony/pushy/src/main/ets/PushyConfiguration';
import {
  decodeNativeText,
  encodeNativeText,
} from '../../scripts/encode-native-text';

const root = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

// Service addresses and the request path must only appear encoded in shipped
// native code (see scripts/encode-native-text.ts).
const plainTexts = [
  '/checkUpdate/',
  'https://update.react-native.cn/api',
  'https://update.reactnative.cn/api',
  'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
  'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json',
];

const shippedNativeSources = (dir: string): string[] =>
  readdirSync(new URL(dir, root), { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /\.(?:h|m|mm|java|kt|ts|ets|cpp)$/.test(entry.name)
    )
    .map((entry) =>
      `${entry.parentPath}/${entry.name}`.slice(
        new URL(dir, root).pathname.length - dir.length
      )
    )
    .filter((path) => !/\/tests?\//.test(path));

const paths = [
  'ios/',
  'android/src/main/',
  'harmony/pushy/src/main/',
  'cpp/patch_core/',
  'cpp/update_flow_core/',
].flatMap(shippedNativeSources);

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');

const encodedIn = (text: string) =>
  [
    ...text.matchAll(
      /\b(?:HttpUtils\.reveal|reveal|RCTPushyRevealText|revealText)\(\s*["']([0-9a-f]+)["']\s*\)/g
    ),
  ].map((match) => match[1]);

describe('native text encoding', () => {
  test('encoding round-trips', () => {
    for (const text of plainTexts) {
      expect(decodeNativeText(encodeNativeText(text))).toBe(text);
      expect(revealText(encodeNativeText(text))).toBe(text);
    }
  });

  test('each platform encodes exactly the expected texts', () => {
    const platforms = {
      android: paths.filter((path) => path.startsWith('android/')),
      ios: paths.filter((path) => path.startsWith('ios/')),
      harmony: paths.filter((path) => path.startsWith('harmony/')),
    };
    for (const [platform, files] of Object.entries(platforms)) {
      const decoded = files
        .flatMap((path) => encodedIn(source(path)))
        .map(decodeNativeText)
        .sort();
      expect({ platform, decoded }).toEqual({
        platform,
        decoded: [...plainTexts].sort(),
      });
    }
  });

  test('shipped native code has no plain service addresses or paths', () => {
    const offenders = paths.flatMap((path) => {
      const code = stripComments(source(path));
      return plainTexts
        .filter((text) => code.includes(text))
        .map((text) => `${path}: ${text}`);
    });
    expect(offenders).toEqual([]);
  });

  test('Harmony resolves the path and default addresses at runtime', () => {
    expect(QUERY_PATH).toBe('/checkUpdate/');
    const config = JSON.parse(normalizePushyConfiguration({ appKey: 'k' }));
    expect(config.endpoints).toEqual(plainTexts.slice(1, 3));
    expect(config.queryUrls).toEqual(plainTexts.slice(3));
  });
});
