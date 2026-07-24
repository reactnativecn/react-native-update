/**
 * Harmony update-flow e2e, mirroring the Detox local-merge suite:
 * binary base -> full package (v1) -> ppk diff (v2) -> v2-track diff (v4)
 * -> persistence.
 *
 * Prerequisites:
 * - Emulator/device in `hdc list targets`
 * - The harmony base hap built from Example/harmony_use_pushy with the e2e
 *   entry (e2e/entry.base.ts) installed on the device
 * - Artifacts + local server are handled by globalSetup (E2E_PLATFORM=harmony)
 */
import { HarmonyDriver } from '../harness/harmony-driver.ts';

const BUNDLE_NAME =
  process.env.RNU_HARMONY_BUNDLE_NAME || 'com.charmlot.testpushy';
const LABELS = {
  base: 'BINARY_BASE',
  full: 'E2E_FULL_V1',
  ppkPatch: 'E2E_PPK_PATCH_V2',
  v2Track: 'E2E_V2TRACK_V4',
} as const;
const LOCAL_UPDATE_PORT = 31337;

const READY_TIMEOUT = 60000;
const RELOAD_TIMEOUT = 120000;
const RETRYABLE_RELOAD_TIMEOUT = 45000;
const MAX_CHECK_UPDATE_ATTEMPTS = 2;

const driver = new HarmonyDriver(BUNDLE_NAME);

async function waitForBundleLabel(expectedLabel: string, timeout: number) {
  const expectedText = `bundleLabel: ${expectedLabel}`;
  await driver.waitFor(
    async () => {
      const node = await driver.findById('bundle-label');
      return node?.text === expectedText ? node : undefined;
    },
    { timeout, description: `bundle-label "${expectedText}"` }
  );
}

async function tapCheckUpdateAndWaitForBundleLabel(expectedLabel: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHECK_UPDATE_ATTEMPTS; attempt++) {
    await driver.tapById('check-update', { timeout: READY_TIMEOUT });
    try {
      await waitForBundleLabel(
        expectedLabel,
        attempt < MAX_CHECK_UPDATE_ATTEMPTS
          ? RETRYABLE_RELOAD_TIMEOUT
          : RELOAD_TIMEOUT
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_CHECK_UPDATE_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError;
}

beforeAll(async () => {
  const targets = await HarmonyDriver.listTargets();
  if (targets.length === 0) {
    throw new Error(
      'No HarmonyOS device/emulator connected (hdc list targets is empty)'
    );
  }
  await driver.rport(LOCAL_UPDATE_PORT, LOCAL_UPDATE_PORT);
}, 30000);

describe('harmony local update flow', () => {
  it('starts from the binary base bundle after a data reset', async () => {
    await driver.terminate();
    // Reset pushy state so the run is deterministic regardless of what a
    // previous run downloaded.
    await driver.shell(`bm clean -n ${BUNDLE_NAME} -d`);
    await driver.launch();
    await waitForBundleLabel(LABELS.base, READY_TIMEOUT);
  });

  it('applies the full package update (v1)', async () => {
    await tapCheckUpdateAndWaitForBundleLabel(LABELS.full);
  });

  it('applies the ppk diff update (v2)', async () => {
    await tapCheckUpdateAndWaitForBundleLabel(LABELS.ppkPatch);
  });

  it('applies the v2-track diff update (v4)', async () => {
    await tapCheckUpdateAndWaitForBundleLabel(LABELS.v2Track);
  });

  it('keeps the applied update across a relaunch', async () => {
    await driver.relaunch();
    await waitForBundleLabel(LABELS.v2Track, READY_TIMEOUT);
  });

  it('reports up to date without switching bundles', async () => {
    await driver.tapById('check-update', { timeout: READY_TIMEOUT });
    // Give a would-be update time to download and restart, then confirm the
    // label is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await waitForBundleLabel(LABELS.v2Track, READY_TIMEOUT);
  });
});
