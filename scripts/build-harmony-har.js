#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const androidJniDir = path.join(projectRoot, 'android', 'jni');
const patchCoreDir = path.join(projectRoot, 'cpp', 'patch_core');
const harmonyModuleDir = path.join(projectRoot, 'harmony', 'pushy');
const harmonyBuildDir = path.join(harmonyModuleDir, 'build');
const harmonyNativeStageDir = path.join(
  harmonyModuleDir,
  'src',
  'main',
  'cpp',
  'android-generated',
);
const harmonyNativeStageJniDir = path.join(harmonyNativeStageDir, 'jni');
const harmonyNativeStagePatchCoreDir = path.join(
  harmonyNativeStageDir,
  'patch_core',
);
const wrapperProjectDir = path.join(projectRoot, 'harmony', 'har-wrapper');
const defaultOutputPath = path.join(projectRoot, 'harmony', 'pushy.har');
const wrapperProjectFiles = [
  'hvigorfile.ts',
  path.join('hvigor', 'hvigor-config.json5'),
  'oh-package.json5',
  path.join('AppScope', 'app.json5'),
  'build-profile.json5',
];

const args = parseArgs(process.argv.slice(2));
const buildMode = normalizeBuildMode(
  args['build-mode'] || process.env.HARMONY_BUILD_MODE || 'debug',
);
const skipInstall =
  args['skip-install'] || process.env.HARMONY_SKIP_INSTALL === '1';
const outputDir = args['out-dir']
  ? path.resolve(projectRoot, args['out-dir'])
  : process.env.HARMONY_HAR_OUTPUT_DIR
    ? path.resolve(projectRoot, process.env.HARMONY_HAR_OUTPUT_DIR)
    : null;
const outputPath = args['out-file']
  ? path.resolve(projectRoot, args['out-file'])
  : process.env.HARMONY_HAR_OUTPUT_PATH
    ? path.resolve(projectRoot, process.env.HARMONY_HAR_OUTPUT_PATH)
    : outputDir
      ? null
      : defaultOutputPath;

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function main() {
  syncHarmonyNativeSources();
  let buildError = null;

  try {
    buildHar();
  } catch (error) {
    buildError = error;
  }

  try {
    cleanupHarmonyNativeSources();
  } catch (error) {
    if (!buildError) {
      buildError = error;
    } else {
      console.warn(
        `Warning: failed to clean staged Harmony native sources: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (buildError) {
    throw buildError;
  }
}

function buildHar() {
  ensureWrapperProject();

  const devecoRoots = getDevEcoRoots();
  const hvigorwPath = resolveBinary('hvigorw', [
    process.env.HVIGORW_PATH,
    ...devecoRoots.map((root) =>
      path.join(root, 'tools', 'hvigor', 'bin', 'hvigorw'),
    ),
  ]);
  const ohpmPath = resolveBinary('ohpm', [
    process.env.OHPM_PATH,
    ...devecoRoots.map((root) =>
      path.join(root, 'tools', 'ohpm', 'bin', 'ohpm'),
    ),
  ]);

  if (!hvigorwPath) {
    fail(
      'Cannot find hvigorw. Set HVIGORW_PATH or install DevEco Studio.',
    );
  }

  if (!ohpmPath) {
    fail('Cannot find ohpm. Set OHPM_PATH or install DevEco Studio.');
  }

  const env = {
    ...process.env,
  };

  if (!env.DEVECO_SDK_HOME) {
    const devecoSdkHome = findExistingPath(
      devecoRoots.map((root) => path.join(root, 'sdk')),
    );
    if (devecoSdkHome) {
      env.DEVECO_SDK_HOME = devecoSdkHome;
    }
  }

  if (!env.DEVECO_STUDIO_HOME) {
    const devecoStudioHome = findExistingPath(devecoRoots);
    if (devecoStudioHome) {
      env.DEVECO_STUDIO_HOME = devecoStudioHome;
    }
  }

  if (!skipInstall) {
    runCommand(ohpmPath, ['install'], {
      cwd: harmonyModuleDir,
      env,
      label: 'Install Harmony dependencies',
    });

    runCommand(ohpmPath, ['install'], {
      cwd: wrapperProjectDir,
      env,
      label: 'Install wrapper project dependencies',
    });
  }

  const hvigorArgs = ['assembleHar'];
  if (buildMode !== 'debug') {
    hvigorArgs.push('-p', `buildMode=${buildMode}`);
  }

  runCommand(hvigorwPath, hvigorArgs, {
    cwd: wrapperProjectDir,
    env,
    label: `Build Harmony HAR (${buildMode})`,
  });

  const harPath = findNewestHar(harmonyBuildDir);
  if (!harPath) {
    fail(
      `Build finished but no .har artifact was found under ${relativeToProject(
        harmonyBuildDir,
      )}`,
    );
  }

  let finalPath = harPath;
  if (outputDir || outputPath) {
    finalPath = outputPath || path.join(outputDir, path.basename(harPath));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.copyFileSync(harPath, finalPath);
  }

  console.log(`HAR package ready: ${finalPath}`);
}

function syncHarmonyNativeSources() {
  ensureFileExists(
    path.join(androidJniDir, 'hpatch.c'),
    `Missing Android native source: ${relativeToProject(
      path.join(androidJniDir, 'hpatch.c'),
    )}`,
  );
  ensureFileExists(
    path.join(androidJniDir, 'hpatch.h'),
    `Missing Android native source: ${relativeToProject(
      path.join(androidJniDir, 'hpatch.h'),
    )}`,
  );
  ensureFileExists(
    path.join(androidJniDir, 'HDiffPatch'),
    `Missing Android native source directory: ${relativeToProject(
      path.join(androidJniDir, 'HDiffPatch'),
    )}`,
  );
  ensureFileExists(
    path.join(androidJniDir, 'lzma', 'C'),
    `Missing Android native source directory: ${relativeToProject(
      path.join(androidJniDir, 'lzma', 'C'),
    )}`,
  );
  ensureFileExists(
    path.join(patchCoreDir, 'patch_core.cpp'),
    `Missing shared patch core source: ${relativeToProject(
      path.join(patchCoreDir, 'patch_core.cpp'),
    )}`,
  );

  fs.rmSync(harmonyNativeStageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(harmonyNativeStageJniDir, 'lzma'), {
    recursive: true,
  });

  copyPath(
    path.join(androidJniDir, 'hpatch.c'),
    path.join(harmonyNativeStageJniDir, 'hpatch.c'),
  );
  copyPath(
    path.join(androidJniDir, 'hpatch.h'),
    path.join(harmonyNativeStageJniDir, 'hpatch.h'),
  );
  copyPath(
    path.join(androidJniDir, 'HDiffPatch'),
    path.join(harmonyNativeStageJniDir, 'HDiffPatch'),
  );
  copyPath(
    path.join(androidJniDir, 'lzma', 'C'),
    path.join(harmonyNativeStageJniDir, 'lzma', 'C'),
  );
  copyPath(patchCoreDir, harmonyNativeStagePatchCoreDir);
}

function cleanupHarmonyNativeSources() {
  fs.rmSync(harmonyNativeStageDir, { recursive: true, force: true });
}

function copyPath(sourcePath, targetPath) {
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      filter: (entry) => path.basename(entry) !== '.git',
    });
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function ensureWrapperProject() {
  wrapperProjectFiles.forEach((relativePath) => {
    const fullPath = path.join(wrapperProjectDir, relativePath);
    ensureFileExists(
      fullPath,
      `Missing Harmony wrapper file: ${relativeToProject(fullPath)}`,
    );
  });
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      fail(`Unsupported argument: ${token}`);
    }

    const keyValue = token.slice(2).split('=');
    const key = keyValue[0];
    const inlineValue = keyValue.length > 1 ? keyValue.slice(1).join('=') : '';

    if (key === 'skip-install') {
      parsed[key] = true;
      continue;
    }

    const value = inlineValue || argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`Missing value for --${key}`);
    }

    parsed[key] = value;
    if (!inlineValue) {
      index += 1;
    }
  }

  return parsed;
}

function normalizeBuildMode(value) {
  const mode = String(value).toLowerCase();
  if (mode === 'debug' || mode === 'release') {
    return mode;
  }

  fail(`Unsupported build mode: ${value}. Use debug or release.`);
}

function getDevEcoRoots() {
  const roots = new Set();
  const envCandidates = [
    process.env.DEVECO_STUDIO_HOME,
    process.env.DEVECO_SDK_HOME,
  ].filter(Boolean);

  envCandidates.forEach((candidate) => {
    const normalized = normalizeDevEcoRoot(candidate);
    if (normalized) {
      roots.add(normalized);
    }
  });

  roots.add('/Applications/DevEco-Studio.app/Contents');
  return Array.from(roots);
}

function normalizeDevEcoRoot(value) {
  const resolved = path.resolve(value);
  const basename = path.basename(resolved);

  if (basename === 'sdk') {
    return path.dirname(resolved);
  }

  if (basename === 'Contents') {
    return resolved;
  }

  if (resolved.endsWith('.app')) {
    return path.join(resolved, 'Contents');
  }

  if (fs.existsSync(path.join(resolved, 'Contents', 'tools'))) {
    return path.join(resolved, 'Contents');
  }

  return resolved;
}

function resolveBinary(name, candidates) {
  const explicitPath = findExistingPath(candidates);
  if (explicitPath) {
    return explicitPath;
  }

  const whichResult = spawnSync('bash', ['-lc', `command -v ${name}`], {
    encoding: 'utf8',
  });
  if (whichResult.status === 0) {
    const resolved = whichResult.stdout.trim();
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function findExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function runCommand(command, commandArgs, options) {
  const { cwd, env, label } = options;
  console.log(`> ${label}`);
  console.log(`  ${[command, ...commandArgs].join(' ')}`);

  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status || 1}.`);
  }
}

function findNewestHar(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  let latestFile = null;
  let latestMtime = 0;
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.har')) {
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (!latestFile || stat.mtimeMs > latestMtime) {
        latestFile = fullPath;
        latestMtime = stat.mtimeMs;
      }
    }
  }

  return latestFile;
}

function ensureFileExists(filePath, message) {
  if (!fs.existsSync(filePath)) {
    fail(message);
  }
}

function relativeToProject(filePath) {
  return path.relative(projectRoot, filePath) || '.';
}

function fail(message) {
  throw new Error(message);
}
