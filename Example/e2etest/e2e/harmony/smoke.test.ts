/**
 * Driver sanity checks for the HarmonyOS e2e chain (hdc + uitest), run
 * against the e2e base app (Example/harmony_use_pushy built with
 * e2e/entry.base.ts). The full update flow lives in local-update.test.ts.
 */
import { HarmonyDriver } from '../harness/harmony-driver.ts';

const BUNDLE_NAME =
  process.env.RNU_HARMONY_BUNDLE_NAME || 'com.charmlot.testpushy';
const READY_TIMEOUT = 60000;

const driver = new HarmonyDriver(BUNDLE_NAME);

beforeAll(async () => {
  const targets = await HarmonyDriver.listTargets();
  if (targets.length === 0) {
    throw new Error(
      'No HarmonyOS device/emulator connected (hdc list targets is empty)'
    );
  }
}, 30000);

describe('harmony driver smoke', () => {
  it('launches the app and locates elements by testID', async () => {
    await driver.relaunch();

    const label = await driver.waitForById('bundle-label', {
      timeout: READY_TIMEOUT,
    });
    expect(label.text).toMatch(/^bundleLabel: /);

    const button = await driver.waitForById('check-update');
    expect(button.center).not.toBeNull();
  });

  it('locates elements by visible text', async () => {
    await driver.waitForByText('react-native-update harmony e2e');
    const version = await driver.waitForById('client-version');
    expect(version.text).toMatch(/clientVersion: \d+\./);
  });

  it('survives a relaunch preserving install state', async () => {
    const before = (await driver.waitForById('bundle-label')).text;
    await driver.relaunch();
    const after = (
      await driver.waitForById('bundle-label', { timeout: READY_TIMEOUT })
    ).text;
    expect(after).toBe(before);
  });
});
