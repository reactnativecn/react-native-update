import { by, device, element, waitFor } from 'detox';
import {
  getLocalUpdateEndpoint,
  LOCAL_UPDATE_HASHES,
  LOCAL_UPDATE_LABELS,
  LOCAL_UPDATE_PORT,
} from './localUpdateConfig.ts';

// The native cold-start check (NATIVE_CHECKUPDATE_DESIGN §10) exists for one
// scenario: the running update is broken badly enough that JS never starts, so
// nothing in JS can fetch the fix. Staging a genuinely bricked bundle is not
// testable through Detox — it cannot attach to an app whose JS never boots — so
// this suite covers the same capability minus that one step: the app never
// performs a JS check (checkStrategy: null, and the check button is never
// tapped), yet the device still ends up on a new version. Only the native
// orchestrator can produce that outcome.
//
// The activation itself is driven by the server's per-version forceBoot
// directive, which is exactly how a real rescue is triggered from the console.

const NATIVE_CHECK_SETTLE_MS = 25000;
const READY_TIMEOUT = 30000;
const LABEL_TIMEOUT = 30000;

function getDetoxLaunchArgs() {
  if (device.getPlatform() !== 'android') {
    return {};
  }
  return { launchArgs: { detoxEnableSynchronization: '0' } };
}

async function relaunchAppPreservingData() {
  await device.launchApp({ newInstance: true, ...getDetoxLaunchArgs() });
  // The native check talks to the same local server; keeping those requests out
  // of Detox's idle synchronization is what the other suites do too.
  await device.setURLBlacklist([`.*:${LOCAL_UPDATE_PORT}.*`]);
}

async function setForceBoot(enabled: boolean) {
  const endpoint = getLocalUpdateEndpoint(device.getPlatform());
  // Reached from the test runner (the host), not from the device, so localhost
  // is correct even when the app talks to 10.0.2.2.
  const hostEndpoint = endpoint.replace('10.0.2.2', '127.0.0.1');
  const response = await fetch(`${hostEndpoint}/control/force-boot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(`failed to set forceBoot=${enabled}: ${response.status}`);
  }
}

async function waitForReady() {
  await waitFor(element(by.id('bundle-label')))
    .toBeVisible()
    .withTimeout(READY_TIMEOUT);
}

async function waitForBundleLabel(label: string) {
  await waitFor(element(by.id('bundle-label')))
    .toHaveText(`bundleLabel: ${label}`)
    .withTimeout(LABEL_TIMEOUT);
}

async function waitForHash(hash: string) {
  await waitFor(element(by.id('current-hash')))
    .toHaveText(`currentHash: ${hash || '(empty)'}`)
    .withTimeout(LABEL_TIMEOUT);
}

async function resetToPackagedBundle() {
  await waitFor(element(by.id('reset-to-packaged')))
    .toBeVisible()
    .withTimeout(READY_TIMEOUT);
  await element(by.id('reset-to-packaged')).tap();
  await waitFor(element(by.id('last-event')))
    .toHaveText('lastEvent: resetDone')
    .withTimeout(15000);
}

describe('Native cold-start check', () => {
  beforeAll(async () => {
    await device.launchApp({ delete: true, ...getDetoxLaunchArgs() });
  });

  beforeEach(async () => {
    await setForceBoot(false);
    await relaunchAppPreservingData();
    await waitForReady();
    await resetToPackagedBundle();
    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.base);
    await waitForHash('');
  });

  afterAll(async () => {
    // Never leave the directive on: the other suites drive activation
    // themselves and would race a forced one.
    await setForceBoot(false);
  });

  it('installs a forceBoot version without any JS check', async () => {
    await setForceBoot(true);

    // This launch schedules the native round; the app itself never checks
    // (checkStrategy is null and the check button is not tapped).
    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.base);
    await new Promise((resolve) =>
      setTimeout(resolve, NATIVE_CHECK_SETTLE_MS)
    );

    // Turn the directive off before observing, so the next launch cannot walk
    // further along the update chain while the assertions run.
    await setForceBoot(false);
    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.full);
    await waitForHash(LOCAL_UPDATE_HASHES.full);
  });

  it('leaves the app on the packaged bundle when nothing is forced', async () => {
    // Same wait, no directive: with checkStrategy null the native check may
    // download but must never activate on its own.
    await relaunchAppPreservingData();
    await waitForReady();
    await new Promise((resolve) =>
      setTimeout(resolve, NATIVE_CHECK_SETTLE_MS)
    );

    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.base);
    await waitForHash('');
  });
});
