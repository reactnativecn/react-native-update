import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const android = 'android/src/main/java/cn/reactnative/modules/update/';
const harmony = 'harmony/pushy/src/main/ets/';
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

// These are forbidden host API identifiers, not backend paths or JS bridge names.
const oldNames =
  /\b(?:PushyNativeUpdate|NativeUpdateResult|NativeUpdateConfig|RCTPushyNativeUpdateCompletion|checkAndUpdate(?:WithCompletion|Native)?)\b/;

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

  test('renamed host entry files contain no deprecated native aliases', () => {
    for (const path of [
      `${android}PushyRuntime.java`,
      `${android}BundlePreparationResult.java`,
      `${android}PushyConfiguration.java`,
      `${harmony}BundlePreparationResult.ts`,
      `${harmony}PushyConfiguration.ts`,
    ]) {
      expect(source(path)).not.toMatch(oldNames);
    }
  });
});
