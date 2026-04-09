import { by, device, element, waitFor } from 'detox';
import { LOCAL_UPDATE_HASHES, LOCAL_UPDATE_LABELS } from './localUpdateConfig.ts';

const RELOAD_TIMEOUT = 180000;
const MARK_SUCCESS_TIMEOUT = 30000;
const MARK_SUCCESS_SETTLE_MS = 1500;

async function tapCheckUpdate() {
  await waitFor(element(by.id('check-update'))).toBeVisible().withTimeout(30000);
  await element(by.id('check-update')).tap();
}

async function waitForBundleLabel(expectedLabel: string) {
  await waitFor(element(by.id('bundle-label')))
    .toHaveText(`bundleLabel: ${expectedLabel}`)
    .withTimeout(RELOAD_TIMEOUT);
}

async function waitForHash(expectedHash: string) {
  await waitFor(element(by.id('current-hash')))
    .toHaveText(`currentHash: ${expectedHash}`)
    .withTimeout(RELOAD_TIMEOUT);
}

async function waitForMarkSuccess() {
  await waitFor(element(by.id('last-event')))
    .toHaveText('lastEvent: markSuccess')
    .withTimeout(MARK_SUCCESS_TIMEOUT);
  await new Promise(resolve => setTimeout(resolve, MARK_SUCCESS_SETTLE_MS));
}

async function waitForReady() {
  await waitFor(element(by.id('check-update'))).toBeVisible().withTimeout(30000);
}

describe('Local Update Merge E2E', () => {
  beforeAll(async () => {
    await device.launchApp({
      newInstance: true,
      delete: true,
      ...(device.getPlatform() === 'android'
        ? {
            launchArgs: {
              detoxEnableSynchronization: '0',
            },
          }
        : {}),
    });
  });

  it('covers local full update, diff merge, and package diff through checkUpdate + silentAndNow', async () => {
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.base);

    await tapCheckUpdate();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.full);
    await waitForHash(LOCAL_UPDATE_HASHES.full);
    await waitForMarkSuccess();

    await tapCheckUpdate();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.ppkPatch);
    await waitForHash(LOCAL_UPDATE_HASHES.ppkPatch);
    await waitForMarkSuccess();

    if (device.getPlatform() === 'android') {
      await tapCheckUpdate();
      await waitForBundleLabel(LOCAL_UPDATE_LABELS.packagePatch);
      await waitForHash(LOCAL_UPDATE_HASHES.packagePatch);
      await waitForMarkSuccess();
    }
  });
});
