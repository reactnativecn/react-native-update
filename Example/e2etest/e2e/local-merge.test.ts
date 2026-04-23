import { by, device, element, waitFor } from 'detox';
import { LOCAL_UPDATE_HASHES, LOCAL_UPDATE_LABELS } from './localUpdateConfig.ts';

const RELOAD_TIMEOUT = 180000;
const MARK_SUCCESS_TIMEOUT = 30000;
const MARK_SUCCESS_SETTLE_MS = 1500;
const DOWNLOAD_SUCCESS_TIMEOUT = 120000;

function getDetoxLaunchArgs() {
  if (device.getPlatform() !== 'android') {
    return {};
  }

  return {
    launchArgs: {
      detoxEnableSynchronization: '0',
    },
  };
}

async function relaunchAppPreservingData() {
  await device.launchApp({
    newInstance: true,
    ...getDetoxLaunchArgs(),
  });
}

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
  const visibleHash = expectedHash || '(empty)';
  await waitFor(element(by.id('current-hash')))
    .toHaveText(`currentHash: ${visibleHash}`)
    .withTimeout(RELOAD_TIMEOUT);
}

async function waitForMarkSuccess() {
  await waitFor(element(by.id('last-event')))
    .toHaveText('lastEvent: markSuccess')
    .withTimeout(MARK_SUCCESS_TIMEOUT);
  await new Promise(resolve => setTimeout(resolve, MARK_SUCCESS_SETTLE_MS));
}

async function waitForDownloadSuccess(expectedHash: string) {
  await waitFor(element(by.id('last-event')))
    .toHaveText('lastEvent: downloadSuccess')
    .withTimeout(DOWNLOAD_SUCCESS_TIMEOUT);
  await waitFor(element(by.id('last-event-version')))
    .toHaveText(`lastEventVersion: ${expectedHash}`)
    .withTimeout(DOWNLOAD_SUCCESS_TIMEOUT);
}

async function waitForReady() {
  await waitFor(element(by.id('check-update'))).toBeVisible().withTimeout(30000);
}

async function waitForCheckState(expectedStatus: string, expectedResult: string) {
  await waitFor(element(by.id('last-check-status')))
    .toHaveText(`lastCheckStatus: ${expectedStatus}`)
    .withTimeout(RELOAD_TIMEOUT);
  await waitFor(element(by.id('last-check-result')))
    .toHaveText(`lastCheckResult: ${expectedResult}`)
    .withTimeout(RELOAD_TIMEOUT);
}

async function waitForStrategy(expectedStrategy: 'silentAndNow' | 'silentAndLater') {
  await waitFor(element(by.id('update-strategy')))
    .toHaveText(`updateStrategy: ${expectedStrategy}`)
    .withTimeout(10000);
}

async function selectStrategy(testId: 'strategy-silent-now' | 'strategy-silent-later') {
  await waitFor(element(by.id(testId))).toBeVisible().withTimeout(10000);
  await element(by.id(testId)).tap();
}

describe('Local Update Merge E2E', () => {
  beforeEach(async () => {
    await device.launchApp({
      newInstance: true,
      delete: true,
      ...getDetoxLaunchArgs(),
    });
  });

  it('covers local full update, diff merge, and package diff through checkUpdate + silentAndNow', async () => {
    await waitForReady();
    await waitForStrategy('silentAndNow');
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

    const finalLabel =
      device.getPlatform() === 'android'
        ? LOCAL_UPDATE_LABELS.packagePatch
        : LOCAL_UPDATE_LABELS.ppkPatch;
    const finalHash =
      device.getPlatform() === 'android'
        ? LOCAL_UPDATE_HASHES.packagePatch
        : LOCAL_UPDATE_HASHES.ppkPatch;

    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(finalLabel);
    await waitForHash(finalHash);

    await tapCheckUpdate();
    await waitForCheckState('completed', 'upToDate');
    await waitForBundleLabel(finalLabel);
    await waitForHash(finalHash);
  });

  it('covers local full update, deferred install, and follow-up deferred patches through silentAndLater', async () => {
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.base);

    await selectStrategy('strategy-silent-later');
    await waitForStrategy('silentAndLater');

    await tapCheckUpdate();
    await waitForCheckState('completed', `update:${LOCAL_UPDATE_HASHES.full}`);
    await waitForDownloadSuccess(LOCAL_UPDATE_HASHES.full);
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.base);
    await waitForHash('');

    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.full);
    await waitForHash(LOCAL_UPDATE_HASHES.full);
    await waitForMarkSuccess();

    await selectStrategy('strategy-silent-later');
    await waitForStrategy('silentAndLater');
    await tapCheckUpdate();
    await waitForCheckState('completed', `update:${LOCAL_UPDATE_HASHES.ppkPatch}`);
    await waitForDownloadSuccess(LOCAL_UPDATE_HASHES.ppkPatch);
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.full);
    await waitForHash(LOCAL_UPDATE_HASHES.full);

    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.ppkPatch);
    await waitForHash(LOCAL_UPDATE_HASHES.ppkPatch);
    await waitForMarkSuccess();

    if (device.getPlatform() === 'android') {
      await selectStrategy('strategy-silent-later');
      await waitForStrategy('silentAndLater');
      await tapCheckUpdate();
      await waitForCheckState(
        'completed',
        `update:${LOCAL_UPDATE_HASHES.packagePatch}`,
      );
      await waitForDownloadSuccess(LOCAL_UPDATE_HASHES.packagePatch);
      await waitForBundleLabel(LOCAL_UPDATE_LABELS.ppkPatch);
      await waitForHash(LOCAL_UPDATE_HASHES.ppkPatch);

      await relaunchAppPreservingData();
      await waitForReady();
      await waitForBundleLabel(LOCAL_UPDATE_LABELS.packagePatch);
      await waitForHash(LOCAL_UPDATE_HASHES.packagePatch);
      await waitForMarkSuccess();
    }

    const finalLabel =
      device.getPlatform() === 'android'
        ? LOCAL_UPDATE_LABELS.packagePatch
        : LOCAL_UPDATE_LABELS.ppkPatch;
    const finalHash =
      device.getPlatform() === 'android'
        ? LOCAL_UPDATE_HASHES.packagePatch
        : LOCAL_UPDATE_HASHES.ppkPatch;

    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(finalLabel);
    await waitForHash(finalHash);

    await tapCheckUpdate();
    await waitForCheckState('completed', 'upToDate');
    await waitForBundleLabel(finalLabel);
    await waitForHash(finalHash);
  });
});
