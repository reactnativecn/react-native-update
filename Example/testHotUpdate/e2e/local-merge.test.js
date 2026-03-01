const { by, device, element, expect, waitFor } = require('detox');
const { LOCAL_UPDATE_LABELS } = require('./localUpdateConfig');

const COMMAND_TIMEOUT = 240000;
const RELOAD_TIMEOUT = 180000;

async function openTestConsole() {
  await waitFor(element(by.id('testcase'))).toBeVisible().withTimeout(60000);
  await element(by.id('testcase')).longPress();
  await waitFor(element(by.id('submit'))).toBeVisible().withTimeout(10000);
}

async function tapShortcut(id) {
  await waitFor(element(by.id(id)))
    .toBeVisible()
    .whileElement(by.id('shortcut-list'))
    .scroll(200, 'down');
  await element(by.id(id)).tap();
}

async function runCommand(id, timeout = COMMAND_TIMEOUT) {
  await tapShortcut(id);
  await element(by.id('submit')).tap();
  await waitForCommandDone(timeout);
  await element(by.id('result-clear')).tap();
}

async function runReloadCommand(id, expectedLabel) {
  await tapShortcut(id);
  await element(by.id('submit')).tap();
  await waitFor(element(by.id('bundle-label')))
    .toHaveText(`bundleLabel: ${expectedLabel}`)
    .withTimeout(RELOAD_TIMEOUT);
}

function extractText(attributes) {
  if (!attributes || typeof attributes !== 'object') {
    return '';
  }
  if (typeof attributes.text === 'string') {
    return attributes.text;
  }
  if (typeof attributes.label === 'string') {
    return attributes.label;
  }
  return '';
}

async function waitForCommandDone(timeout) {
  const deadline = Date.now() + timeout;

  await waitFor(element(by.id('command-status')))
    .toBeVisible()
    .withTimeout(timeout);

  while (Date.now() < deadline) {
    const status = extractText(
      await element(by.id('command-status')).getAttributes(),
    );

    if (status === 'done') {
      return;
    }

    if (status === 'error') {
      const message = extractText(
        await element(by.id('command-message')).getAttributes(),
      );
      throw new Error(`Pushy command failed: ${message || '(empty)'}`);
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Pushy command did not finish within ${timeout}ms`);
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

  it('covers local full update and diff merge flow without checkUpdate', async () => {
    await waitFor(element(by.id('bundle-label')))
      .toHaveText(`bundleLabel: ${LOCAL_UPDATE_LABELS.base}`)
      .withTimeout(60000);

    await openTestConsole();
    await runCommand('setLocalHashInfo');
    await runCommand('getLocalHashInfo');
    await runCommand('setUuid');
    await runCommand('downloadFullUpdate');
    await runCommand('setNeedUpdateFull');
    await runReloadCommand('reloadUpdateFull', LOCAL_UPDATE_LABELS.full);

    await openTestConsole();
    await runCommand('markSuccess');
    await runCommand('downloadPatchFromPpk');
    await runCommand('setNeedUpdatePatched');
    await runReloadCommand('reloadUpdatePatched', LOCAL_UPDATE_LABELS.ppkPatch);

    if (device.getPlatform() === 'android') {
      await openTestConsole();
      await runCommand('downloadPatchFromPackage');
      await runCommand('setNeedUpdatePackage');
      await runReloadCommand(
        'reloadUpdatePackage',
        LOCAL_UPDATE_LABELS.packagePatch,
      );

      await openTestConsole();
      await runCommand('downloadAndInstallApk');
    }
  });
});
