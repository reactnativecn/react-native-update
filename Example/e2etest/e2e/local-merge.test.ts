import { by, device, element, waitFor } from 'detox';
import {
  LOCAL_UPDATE_FINAL_STATE,
  LOCAL_UPDATE_HASHES,
  LOCAL_UPDATE_LABELS,
  LOCAL_UPDATE_PORT,
} from './localUpdateConfig.ts';

const RELOAD_TIMEOUT = 180000;
const RETRYABLE_RELOAD_TIMEOUT = 45000;
const MARK_SUCCESS_TIMEOUT = 30000;
const MARK_SUCCESS_SETTLE_MS = 1500;
const DOWNLOAD_SUCCESS_TIMEOUT = 120000;
const MAX_CHECK_UPDATE_ATTEMPTS = 2;

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
  await waitFor(element(by.id('check-update')))
    .toBeVisible()
    .withTimeout(30000);
  await element(by.id('check-update')).tap();
}

async function waitForBundleLabel(
  expectedLabel: string,
  timeoutMs = RELOAD_TIMEOUT,
) {
  await waitFor(element(by.id('bundle-label')))
    .toHaveText(`bundleLabel: ${expectedLabel}`)
    .withTimeout(timeoutMs);
}

async function tapCheckUpdateAndWaitForBundleLabel(expectedLabel: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_CHECK_UPDATE_ATTEMPTS; attempt++) {
    await tapCheckUpdate();

    try {
      await waitForBundleLabel(
        expectedLabel,
        attempt < MAX_CHECK_UPDATE_ATTEMPTS
          ? RETRYABLE_RELOAD_TIMEOUT
          : RELOAD_TIMEOUT,
      );
      return;
    } catch (error) {
      lastError = error;

      if (attempt >= MAX_CHECK_UPDATE_ATTEMPTS) {
        throw error;
      }

      await waitForReady();
    }
  }

  throw lastError;
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
  await waitFor(element(by.id('check-update')))
    .toBeVisible()
    .withTimeout(30000);
}

async function waitForCheckState(
  expectedStatus: string,
  expectedResult: string,
) {
  await waitFor(element(by.id('last-check-status')))
    .toHaveText(`lastCheckStatus: ${expectedStatus}`)
    .withTimeout(RELOAD_TIMEOUT);
  await waitFor(element(by.id('last-check-result')))
    .toHaveText(`lastCheckResult: ${expectedResult}`)
    .withTimeout(RELOAD_TIMEOUT);
}

async function waitForStrategy(
  expectedStrategy: 'silentAndNow' | 'silentAndLater',
) {
  await waitFor(element(by.id('update-strategy')))
    .toHaveText(`updateStrategy: ${expectedStrategy}`)
    .withTimeout(10000);
}

async function selectStrategy(
  testId: 'strategy-silent-now' | 'strategy-silent-later',
) {
  await waitFor(element(by.id(testId)))
    .toBeVisible()
    .withTimeout(10000);
  await element(by.id(testId)).tap();
}

function getFinalState() {
  const platform = device.getPlatform();
  return platform in LOCAL_UPDATE_FINAL_STATE
    ? LOCAL_UPDATE_FINAL_STATE[
        platform as keyof typeof LOCAL_UPDATE_FINAL_STATE
      ]
    : LOCAL_UPDATE_FINAL_STATE.default;
}

async function runDeferredUpdate(
  updateHash: string,
  previousLabel: string,
  previousHash: string,
  nextLabel: string,
  nextHash: string,
) {
  await selectStrategy('strategy-silent-later');
  await waitForStrategy('silentAndLater');
  await tapCheckUpdate();
  await waitForCheckState('completed', `update:${updateHash}`);
  await waitForDownloadSuccess(updateHash);
  await waitForBundleLabel(previousLabel);
  await waitForHash(previousHash);

  await relaunchAppPreservingData();
  await waitForReady();
  await waitForBundleLabel(nextLabel);
  await waitForHash(nextHash);
  await waitForMarkSuccess();
}

describe('Local Update Merge E2E', () => {
  beforeEach(async () => {
    await device.launchApp({
      newInstance: true,
      delete: true,
      ...getDetoxLaunchArgs(),
    });
    // 更新下载/检查请求在飞时不能算 "app busy":否则 Detox 的 idle 同步
    // 会干等主队列清空直到用例超时(iOS 上的高频 flake 来源,症状是
    // "work items pending on the dispatch queue")。
    await device.setURLBlacklist([`.*:${LOCAL_UPDATE_PORT}.*`]);
  });

  it('covers local full update, diff merge, package diff, and v2-track diff through checkUpdate + silentAndNow', async () => {
    await waitForReady();
    await waitForStrategy('silentAndNow');
    await waitForBundleLabel(LOCAL_UPDATE_LABELS.base);

    await tapCheckUpdateAndWaitForBundleLabel(LOCAL_UPDATE_LABELS.full);
    await waitForHash(LOCAL_UPDATE_HASHES.full);
    await waitForMarkSuccess();

    await tapCheckUpdateAndWaitForBundleLabel(LOCAL_UPDATE_LABELS.ppkPatch);
    await waitForHash(LOCAL_UPDATE_HASHES.ppkPatch);
    await waitForMarkSuccess();

    if (device.getPlatform() === 'android') {
      await tapCheckUpdateAndWaitForBundleLabel(
        LOCAL_UPDATE_LABELS.packagePatch,
      );
      await waitForHash(LOCAL_UPDATE_HASHES.packagePatch);
      await waitForMarkSuccess();
    }

    if (device.getPlatform() === 'android' || device.getPlatform() === 'ios') {
      await tapCheckUpdateAndWaitForBundleLabel(LOCAL_UPDATE_LABELS.v2Track);
      await waitForHash(LOCAL_UPDATE_HASHES.v2Track);
      await waitForMarkSuccess();
    }

    const finalState = getFinalState();

    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(finalState.label);
    await waitForHash(finalState.hash);

    await tapCheckUpdate();
    await waitForCheckState('completed', 'upToDate');
    await waitForBundleLabel(finalState.label);
    await waitForHash(finalState.hash);
  });

  it('covers local full update, deferred install, and follow-up deferred patches including v2-track through silentAndLater', async () => {
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

    await runDeferredUpdate(
      LOCAL_UPDATE_HASHES.ppkPatch,
      LOCAL_UPDATE_LABELS.full,
      LOCAL_UPDATE_HASHES.full,
      LOCAL_UPDATE_LABELS.ppkPatch,
      LOCAL_UPDATE_HASHES.ppkPatch,
    );

    if (device.getPlatform() === 'android') {
      await runDeferredUpdate(
        LOCAL_UPDATE_HASHES.packagePatch,
        LOCAL_UPDATE_LABELS.ppkPatch,
        LOCAL_UPDATE_HASHES.ppkPatch,
        LOCAL_UPDATE_LABELS.packagePatch,
        LOCAL_UPDATE_HASHES.packagePatch,
      );
    }

    if (device.getPlatform() === 'android' || device.getPlatform() === 'ios') {
      const previousState =
        device.getPlatform() === 'android'
          ? {
              label: LOCAL_UPDATE_LABELS.packagePatch,
              hash: LOCAL_UPDATE_HASHES.packagePatch,
            }
          : {
              label: LOCAL_UPDATE_LABELS.ppkPatch,
              hash: LOCAL_UPDATE_HASHES.ppkPatch,
            };
      await runDeferredUpdate(
        LOCAL_UPDATE_HASHES.v2Track,
        previousState.label,
        previousState.hash,
        LOCAL_UPDATE_LABELS.v2Track,
        LOCAL_UPDATE_HASHES.v2Track,
      );
    }

    const finalState = getFinalState();

    await relaunchAppPreservingData();
    await waitForReady();
    await waitForBundleLabel(finalState.label);
    await waitForHash(finalState.hash);

    await tapCheckUpdate();
    await waitForCheckState('completed', 'upToDate');
    await waitForBundleLabel(finalState.label);
    await waitForHash(finalState.hash);
  });
});
