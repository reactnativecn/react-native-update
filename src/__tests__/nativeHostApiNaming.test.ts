import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const android = 'android/src/main/java/cn/reactnative/modules/update/';
const harmony = 'harmony/pushy/src/main/ets/';
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

// These are forbidden host API identifiers, not backend paths or JS bridge names.
const oldNames =
  /\b(?:PushyNativeUpdate|NativeUpdateResult|NativeUpdateConfig|RCTPushyNativeUpdateCompletion|RCTPushyNativeConfigurationCompletion|RCTPushyNormalizeNativeConfig|checkAndUpdate(?:WithCompletion|Native)?)\b/;
// Any other "native update" wording in shipped native code. NativeUpdateCore and
// NativeUpdateFlow predate the host APIs and are bound by JNI symbol names.
const nativeUpdateWording = /NativeUpdate(?!Core|Flow)|native update/i;

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

describe('native host API naming', () => {
  test('Android exposes prepareBundle through PushyRuntime', () => {
    const entry = source(`${android}PushyRuntime.java`);
    expect(entry).toContain('public final class PushyRuntime');
    expect(entry).toContain('public static void prepareBundle(');
    expect(entry).toContain('NativeCheckOrchestrator.prepareBundle(');
    expect(entry).toContain('void onComplete(BundlePreparationResult result)');
    expect(source(`${android}BundlePreparationResult.java`)).toContain(
      'class BundlePreparationResult'
    );
    expect(source(`${android}PushyConfiguration.java`)).toContain(
      'class PushyConfiguration'
    );
    for (const name of [
      'PushyNativeUpdate',
      'NativeUpdateResult',
      'NativeUpdateConfig',
    ]) {
      expect(existsSync(new URL(`${android}${name}.java`, root))).toBe(false);
    }
  });

  test('Objective-C declarations, implementation and Swift selector agree', () => {
    const header = source('ios/RCTPushy/RCTPushy.h');
    const implementation = source('ios/RCTPushy/RCTPushy.mm');
    expect(header).toContain('prepareBundleWithCompletion:');
    expect(header).toContain('RCTPushyBundlePreparationCompletion');
    expect(header).toContain('NS_SWIFT_NAME(prepareBundle(completion:))');
    expect(implementation).toContain('prepareBundleWithCompletion:');
    expect(implementation).toContain('[RCTPushyOrchestrator prepareBundle]');
    expect(header).not.toMatch(oldNames);
    expect(implementation).not.toMatch(oldNames);
  });

  test('Harmony exports the renamed result and configuration types', () => {
    const provider = source(`${harmony}PushyFileJSBundleProvider.ets`);
    const exports = source('harmony/pushy/index.ets');
    expect(provider).toContain(
      'prepareBundle(): Promise<BundlePreparationResult>'
    );
    expect(provider).toContain(
      'return prepareBundleNative(this.updateContext)'
    );
    expect(provider).toContain('configure(options: PushyConfiguration)');
    expect(exports).toContain('export type { BundlePreparationResult }');
    expect(exports).toContain('export type { PushyConfiguration }');
    expect(provider).not.toMatch(oldNames);
    expect(exports).not.toMatch(oldNames);
    for (const name of ['NativeUpdateResult', 'NativeUpdateConfig']) {
      expect(existsSync(new URL(`${harmony}${name}.ts`, root))).toBe(false);
    }
  });

  test('iOS configuration names match the other platforms', () => {
    const header = source('ios/RCTPushy/RCTPushy.h');
    expect(header).toContain('typedef void (^RCTPushyConfigurationCompletion)');
    expect(source('ios/RCTPushy/RCTPushyConfiguration.h')).toContain(
      'RCTPushyNormalizeConfiguration('
    );
    for (const name of ['RCTPushyNativeConfig.h', 'RCTPushyNativeConfig.mm']) {
      expect(existsSync(new URL(`ios/RCTPushy/${name}`, root))).toBe(false);
    }
  });

  test('shipped native sources contain no old host names or native-update wording', () => {
    const paths = [
      'ios/',
      'android/src/main/',
      'harmony/pushy/src/main/',
      'cpp/patch_core/',
      'cpp/update_flow_core/',
    ].flatMap(shippedNativeSources);
    expect(paths).toContain(`${android}PushyRuntime.java`);
    const offenders = paths.filter((path) => {
      const text = source(path);
      return oldNames.test(text) || nativeUpdateWording.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
