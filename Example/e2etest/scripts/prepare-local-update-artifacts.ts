#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LOCAL_UPDATE_HASHES,
  LOCAL_UPDATE_FILES,
  LOCAL_UPDATE_LABELS,
} from '../e2e/localUpdateConfig';

type DiffCommandRunner = {
  hdiff: (options: {
    args: [string, string];
    options: {
      output: string;
      customDiff: (oldSource?: Buffer, newSource?: Buffer) => Buffer;
      'no-interactive': true;
    };
  }) => Promise<void>;
  hdiffFromApk: (options: {
    args: [string, string];
    options: {
      output: string;
      customDiff: (oldSource?: Buffer, newSource?: Buffer) => Buffer;
      'no-interactive': true;
    };
  }) => Promise<void>;
};

const projectRoot = process.cwd();
const platform = process.env.E2E_PLATFORM || 'ios';
const artifactsRoot = path.join(projectRoot, '.e2e-artifacts');
const artifactsDir = path.join(artifactsRoot, platform);
const diffTimeoutMs = 5 * 60_000;
const localRegistry =
  process.env.PUSHY_REGISTRY || process.env.RNU_API || 'http://127.0.0.1:65535';
const useFullFallbackArtifacts =
  process.env.RNU_E2E_FULL_FALLBACK === 'true' ||
  (platform === 'android' && process.platform === 'linux');

function resolveCliRoot() {
  const candidates = [
    process.env.RNU_CLI_ROOT,
    path.resolve(projectRoot, '../../../react-native-update-cli'),
    path.resolve(projectRoot, '../../react-native-update-cli'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  throw new Error(
    `react-native-update-cli not found. Tried: ${candidates.join(', ')}`,
  );
}

const cliRoot = resolveCliRoot();
const cliPkg = JSON.parse(
  fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'),
);
const binRelative =
  typeof cliPkg.bin === 'string'
    ? cliPkg.bin
    : cliPkg.bin?.pushy ?? Object.values(cliPkg.bin ?? {})[0];
if (!binRelative) {
  throw new Error(
    `react-native-update-cli package.json has no bin entry. Tried: ${cliRoot}`,
  );
}
const cliEntry = path.join(cliRoot, binRelative);

if (!['ios', 'android', 'harmony'].includes(platform)) {
  throw new Error(`Unsupported E2E_PLATFORM: ${platform}`);
}

// The harmony e2e app lives in the RN 0.72 example project (RNOH does not
// support this project's RN version), so its bundles are built from there.
const harmonyProjectRoot = path.resolve(projectRoot, '../harmony_use_pushy');
const bundleProjectRoot =
  platform === 'harmony' ? harmonyProjectRoot : projectRoot;

if (!fs.existsSync(cliEntry)) {
  throw new Error(`react-native-update-cli entry not found: ${cliEntry}`);
}

const { diffCommands } = require(path.join(cliRoot, 'lib/exports.js')) as {
  diffCommands: DiffCommandRunner;
};

function runPushy(args: string[], cwd: string) {
  const cliNodeModules = path.join(cliRoot, 'node_modules');
  const projectNodeModules = path.join(projectRoot, 'node_modules');
  const nodePath = [projectNodeModules, cliNodeModules];
  if (process.env.NODE_PATH) {
    nodePath.push(process.env.NODE_PATH);
  }
  const result = spawnSync('node', [cliEntry, ...args], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_PATH: nodePath.join(path.delimiter),
      NO_INTERACTIVE: 'true',
      PUSHY_REGISTRY: localRegistry,
      RNU_API: localRegistry,
    },
    timeout: 120_000,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `pushy ${args.join(' ')} failed with exit code ${result.status}`,
    );
  }
}

function installHdiffModule() {
  const bunResult = spawnSync(
    'bun',
    ['add', '--no-save', '--trust', 'node-hdiffpatch'],
    {
      cwd: cliRoot,
      stdio: 'inherit',
      env: process.env,
      timeout: 120_000,
    },
  );
  if (bunResult.status === 0) {
    return;
  }

  const npmResult = spawnSync(
    'npm',
    [
      'install',
      '--no-save',
      '--package-lock=false',
      '--legacy-peer-deps',
      'node-hdiffpatch',
    ],
    {
      cwd: cliRoot,
      stdio: 'inherit',
      env: process.env,
      timeout: 120_000,
    },
  );
  if (npmResult.error) {
    throw npmResult.error;
  }
  if (npmResult.status !== 0) {
    throw new Error(
      `npm install node-hdiffpatch failed with exit code ${npmResult.status}`,
    );
  }
}

function ensureHdiffModule() {
  const modulePath = path.join(cliRoot, 'node_modules/node-hdiffpatch');
  if (!fs.existsSync(modulePath)) {
    console.log('node-hdiffpatch not found, installing...');
    installHdiffModule();
  }
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Failed to install node-hdiffpatch under: ${cliRoot}`);
  }
  const hdiffModule = require(modulePath) as {
    diff?: (oldSource?: Buffer, newSource?: Buffer) => Buffer;
  } & ((oldSource?: Buffer, newSource?: Buffer) => Buffer);
  const customDiff = hdiffModule.diff || hdiffModule;
  if (typeof customDiff !== 'function') {
    throw new Error(
      `node-hdiffpatch did not expose a diff function: ${modulePath}`,
    );
  }
  customDiff(
    Buffer.from('rnu-hdiff-smoke-old'),
    Buffer.from('rnu-hdiff-smoke-new'),
  );
  return customDiff;
}

function prepareDir() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
}

function bundleTo(entryFile: string, outputFile: string) {
  console.log(`Bundling ${entryFile} -> ${outputFile}`);
  runPushy(
    [
      'bundle',
      '--platform',
      platform,
      '--entryFile',
      entryFile,
      '--dev',
      'false',
      // The harmony bundler path in the CLI drives Metro itself.
      ...(platform === 'harmony' ? [] : ['--rncli']),
      '--output',
      outputFile,
      '--no-interactive',
    ],
    bundleProjectRoot,
  );
  verifyGeneratedFile(`bundle ${entryFile}`, outputFile);
}

function verifyGeneratedFile(label: string, filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} file not found after generation: ${filePath}`);
  }
  console.log(
    `Verified ${label}: ${filePath} (${fs.statSync(filePath).size} bytes)`,
  );
}

function writeFallbackPatch(label: string, filePath: string) {
  fs.writeFileSync(
    filePath,
    [
      `Invalid ${label} placeholder.`,
      'The local e2e server advertises a full package fallback for this artifact.',
      '',
    ].join('\n'),
  );
  verifyGeneratedFile(`${label} fallback`, filePath);
}

async function keepProcessAlive<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = diffTimeoutMs,
) {
  const timer = setInterval(() => {}, 1000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearInterval(timer);
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function generatePpkDiff(
  origin: string,
  next: string,
  output: string,
  customDiff: (oldSource?: Buffer, newSource?: Buffer) => Buffer,
) {
  console.log(
    `Running hdiff ppk: ${origin} -> ${next} (${fs.statSync(origin).size} -> ${fs.statSync(next).size} bytes)`,
  );
  await keepProcessAlive(
    'ppk diff',
    diffCommands.hdiff({
      args: [origin, next],
      options: {
        output,
        customDiff,
        'no-interactive': true,
      },
    }),
  );
  verifyGeneratedFile('ppk diff', output);
}

async function generateAndroidPackageDiff(
  apkPath: string,
  next: string,
  output: string,
  customDiff: (oldSource?: Buffer, newSource?: Buffer) => Buffer,
) {
  console.log(
    `Running hdiffFromApk: ${apkPath} -> ${next} (${fs.statSync(apkPath).size} -> ${fs.statSync(next).size} bytes)`,
  );
  await keepProcessAlive(
    'package diff',
    diffCommands.hdiffFromApk({
      args: [apkPath, next],
      options: {
        output,
        customDiff,
        'no-interactive': true,
      },
    }),
  );
  verifyGeneratedFile('package diff', output);
}

async function main() {
  prepareDir();

  const v1 = path.join(artifactsDir, LOCAL_UPDATE_FILES.full);
  const v2 = path.join(artifactsDir, LOCAL_UPDATE_FILES.ppkFull);
  const v3 = path.join(artifactsDir, LOCAL_UPDATE_FILES.packageFull);
  const ppkDiff = path.join(artifactsDir, LOCAL_UPDATE_FILES.ppkDiff);

  bundleTo('e2e/entry.v1.ts', v1);
  bundleTo('e2e/entry.v2.ts', v2);
  if (platform !== 'harmony') {
    bundleTo('e2e/entry.v3.ts', v3);
  }

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
    const packageDiffPath = path.join(
      artifactsDir,
      LOCAL_UPDATE_FILES.packageDiff,
    );

    if (useFullFallbackArtifacts) {
      console.log(
        'Using full package fallback artifacts for Android on Linux.',
      );
      writeFallbackPatch('ppk diff', ppkDiff);
      writeFallbackPatch('package diff', packageDiffPath);
    } else {
      const customDiff = ensureHdiffModule();

      console.log('Generating ppk diff...');
      await generatePpkDiff(v1, v2, ppkDiff, customDiff);

      console.log('Generating package diff...');
      await generateAndroidPackageDiff(
        apkPath,
        v3,
        packageDiffPath,
        customDiff,
      );
    }
  } else {
    const customDiff = ensureHdiffModule();

    console.log('Generating ppk diff...');
    await generatePpkDiff(v1, v2, ppkDiff, customDiff);
  }

  const manifestPath = path.join(artifactsDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        platform,
        generatedAt: new Date().toISOString(),
        hashes: LOCAL_UPDATE_HASHES,
        labels: LOCAL_UPDATE_LABELS,
        files: LOCAL_UPDATE_FILES,
        fullFallback: useFullFallbackArtifacts,
      },
      null,
      2,
    ),
  );
  console.log(`Manifest written to ${manifestPath}`);
}

main()
  .then(() => {
    console.log('prepare-local-update-artifacts completed successfully.');
  })
  .catch(error => {
    console.error('prepare-local-update-artifacts failed:');
    console.error(error);
    process.exit(1);
  });
