#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LOCAL_UPDATE_HASHES,
  LOCAL_UPDATE_FILES,
  LOCAL_UPDATE_LABELS,
} = require('../e2e/localUpdateConfig');

const projectRoot = path.resolve(__dirname, '..');
const platform = process.env.E2E_PLATFORM || 'ios';
const artifactsRoot = path.join(projectRoot, '.e2e-artifacts');
const artifactsDir = path.join(artifactsRoot, platform);
const localRegistry =
  process.env.PUSHY_REGISTRY || process.env.RNU_API || 'http://127.0.0.1:65535';

function resolveCliRoot() {
  const candidates = [
    process.env.RNU_CLI_ROOT,
    path.resolve(projectRoot, '../../../react-native-update-cli'),
    path.resolve(projectRoot, '../../react-native-update-cli'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const cliEntry = path.join(candidate, 'lib/index.js');
    if (fs.existsSync(cliEntry)) {
      return candidate;
    }
  }

  throw new Error(
    `react-native-update-cli not found. Tried: ${candidates.join(', ')}`,
  );
}

const cliRoot = resolveCliRoot();
const cliEntry = path.join(cliRoot, 'lib/index.js');
const { diffCommands } = require(path.join(cliRoot, 'lib/diff.js'));

if (!['ios', 'android'].includes(platform)) {
  throw new Error(`Unsupported E2E_PLATFORM: ${platform}`);
}

if (!fs.existsSync(cliEntry)) {
  throw new Error(`react-native-update-cli entry not found: ${cliEntry}`);
}

function runPushy(args, cwd) {
  const nodePath = path.join(cliRoot, 'node_modules');
  const result = spawnSync('node', [cliEntry, ...args], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_PATH: process.env.NODE_PATH
        ? `${nodePath}${path.delimiter}${process.env.NODE_PATH}`
        : nodePath,
      NO_INTERACTIVE: 'true',
      PUSHY_REGISTRY: localRegistry,
      RNU_API: localRegistry,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `pushy ${args.join(' ')} failed with exit code ${result.status}`,
    );
  }
}

function ensureHdiffModule() {
  const modulePath = path.join(cliRoot, 'node_modules/node-hdiffpatch');
  if (!fs.existsSync(modulePath)) {
    console.log('node-hdiffpatch not found, installing...');
    runPushy(['install', 'node-hdiffpatch'], cliRoot);
  }
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Failed to install node-hdiffpatch under: ${cliRoot}`);
  }
  const hdiffModule = require(modulePath);
  return hdiffModule.diff || hdiffModule;
}

function prepareDir() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
}

function bundleTo(entryFile, outputFile) {
  runPushy(
    [
      'bundle',
      '--platform',
      platform,
      '--entryFile',
      entryFile,
      '--dev',
      'false',
      '--rncli',
      '--output',
      outputFile,
      '--no-interactive',
    ],
    projectRoot,
  );
}

async function generatePpkDiff(origin, next, output) {
  const customDiff = ensureHdiffModule();
  await diffCommands.diff({
    args: [origin, next],
    options: {
      output,
      customDiff,
    },
  });
}

async function generateAndroidPackageDiff(apkPath, next, output) {
  const customDiff = ensureHdiffModule();
  await diffCommands.diffFromApk({
    args: [apkPath, next],
    options: {
      output,
      customDiff,
    },
  });
}

async function main() {
  prepareDir();

  const v1 = path.join(artifactsDir, LOCAL_UPDATE_FILES.full);
  const v2 = path.join(artifactsDir, 'v2.ppk');
  const v3 = path.join(artifactsDir, 'v3.ppk');
  const ppkDiff = path.join(artifactsDir, LOCAL_UPDATE_FILES.ppkDiff);

  bundleTo('e2e/entry.v1.js', v1);
  bundleTo('e2e/entry.v2.js', v2);
  bundleTo('e2e/entry.v3.js', v3);
  await generatePpkDiff(v1, v2, ppkDiff);

  if (platform === 'android') {
    const apkPath = path.join(
      projectRoot,
      'android/app/build/outputs/apk/release/app-release.apk',
    );

    if (!fs.existsSync(apkPath)) {
      throw new Error(
        `Android release apk not found: ${apkPath}. Run detox build android.emu.release first.`,
      );
    }

    fs.copyFileSync(apkPath, path.join(artifactsDir, LOCAL_UPDATE_FILES.apk));
    await generateAndroidPackageDiff(
      apkPath,
      v3,
      path.join(artifactsDir, LOCAL_UPDATE_FILES.packageDiff),
    );
  }

  fs.writeFileSync(
    path.join(artifactsDir, 'manifest.json'),
    JSON.stringify(
      {
        platform,
        generatedAt: new Date().toISOString(),
        hashes: LOCAL_UPDATE_HASHES,
        labels: LOCAL_UPDATE_LABELS,
        files: LOCAL_UPDATE_FILES,
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
