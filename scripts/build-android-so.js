#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const androidDir = path.join(repoRoot, 'android');
const jniDir = path.join(androidDir, 'jni');
const libDir = path.join(androidDir, 'lib');
const buildRoot = path.join(androidDir, '.cxx', 'rnupdate-cmake');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const defaultNdkVersion = process.env.ANDROID_NDK_VERSION || '28.2.13676358';
const androidPlatform = process.env.ANDROID_PLATFORM || '21';
const abis = (process.env.ANDROID_ABIS || 'armeabi-v7a,arm64-v8a,x86,x86_64')
  .split(',')
  .map((abi) => abi.trim())
  .filter(Boolean);

function pathExists(targetPath) {
  return Boolean(targetPath) && fs.existsSync(targetPath);
}

function isExecutableFile(targetPath) {
  return pathExists(targetPath) && fs.statSync(targetPath).isFile();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function canRun(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function compareVersionStrings(left, right) {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function listVersionDirectories(rootDir) {
  if (!pathExists(rootDir)) {
    return [];
  }

  return fs
    .readdirSync(rootDir)
    .filter((entry) =>
      fs.statSync(path.join(rootDir, entry)).isDirectory(),
    )
    .sort((left, right) => compareVersionStrings(right, left));
}

function parseSdkDirFromLocalProperties(filePath) {
  if (!pathExists(filePath)) {
    return null;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('sdk.dir=')) {
      continue;
    }

    const sdkDir = line.slice('sdk.dir='.length).replace(/\\\\/g, '\\').trim();
    return pathExists(sdkDir) ? sdkDir : null;
  }

  return null;
}

function getSdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    parseSdkDirFromLocalProperties(path.join(androidDir, 'local.properties')),
    parseSdkDirFromLocalProperties(
      path.join(
        repoRoot,
        'Example',
        'testHotUpdate',
        'android',
        'local.properties',
      ),
    ),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : null,
  ];

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isValidNdkDir(targetPath) {
  return pathExists(path.join(targetPath, 'build', 'cmake', 'android.toolchain.cmake'));
}

function resolveNdkDir() {
  const envCandidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.NDK_HOME,
  ].filter(Boolean);

  for (const candidate of envCandidates) {
    if (isValidNdkDir(candidate)) {
      return candidate;
    }
  }

  const sdkRoot = getSdkRoot();
  if (!sdkRoot) {
    throw new Error(
      'Unable to locate the Android NDK. Set ANDROID_NDK_HOME or ANDROID_HOME.',
    );
  }

  const preferredCandidates = [
    path.join(sdkRoot, 'ndk', defaultNdkVersion),
    path.join(sdkRoot, 'ndk-bundle'),
  ];

  for (const candidate of preferredCandidates) {
    if (isValidNdkDir(candidate)) {
      return candidate;
    }
  }

  const ndkRoot = path.join(sdkRoot, 'ndk');
  for (const versionDir of listVersionDirectories(ndkRoot)) {
    const candidate = path.join(ndkRoot, versionDir);
    if (isValidNdkDir(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate a usable Android NDK under ${sdkRoot}. Set ANDROID_NDK_HOME explicitly.`,
  );
}

function isValidCmakeBinary(targetPath) {
  return isExecutableFile(targetPath);
}

function resolveCmakeBinary() {
  if (process.env.CMAKE_BINARY && isValidCmakeBinary(process.env.CMAKE_BINARY)) {
    return process.env.CMAKE_BINARY;
  }

  if (canRun('cmake', ['--version'])) {
    return 'cmake';
  }

  const sdkRoot = getSdkRoot();
  if (!sdkRoot) {
    throw new Error(
      'Unable to locate CMake. Install it under the Android SDK or add cmake to PATH.',
    );
  }

  const cmakeRoot = path.join(sdkRoot, 'cmake');
  for (const versionDir of listVersionDirectories(cmakeRoot)) {
    const candidate = path.join(cmakeRoot, versionDir, 'bin', `cmake${executableSuffix}`);
    if (isValidCmakeBinary(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate CMake under ${cmakeRoot}. Install it from the Android SDK manager or add cmake to PATH.`,
  );
}

function resolveLlvmStripBinary(ndkDir) {
  const prebuiltRoot = path.join(ndkDir, 'toolchains', 'llvm', 'prebuilt');
  const hostDirs = pathExists(prebuiltRoot)
    ? fs
        .readdirSync(prebuiltRoot)
        .filter((entry) => fs.statSync(path.join(prebuiltRoot, entry)).isDirectory())
        .sort()
    : [];

  for (const hostDir of hostDirs) {
    const candidate = path.join(
      prebuiltRoot,
      hostDir,
      'bin',
      `llvm-strip${executableSuffix}`,
    );
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate llvm-strip under ${prebuiltRoot}.`);
}

function resolveNinjaBinary(cmakeBinary) {
  const bundledNinja = path.join(
    path.dirname(cmakeBinary),
    `ninja${executableSuffix}`,
  );
  if (isExecutableFile(bundledNinja)) {
    return bundledNinja;
  }
  if (canRun('ninja', ['--version'])) {
    return 'ninja';
  }
  return null;
}

function ensureCleanDirectory(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
}

function ensureBuiltLibrary(outputDir) {
  const releaseLibrary = path.join(outputDir, 'Release', 'librnupdate.so');
  const directLibrary = path.join(outputDir, 'librnupdate.so');

  if (pathExists(releaseLibrary) && !pathExists(directLibrary)) {
    fs.copyFileSync(releaseLibrary, directLibrary);
  }

  if (!pathExists(directLibrary)) {
    throw new Error(`Expected output not found: ${directLibrary}`);
  }
}

function configureAndBuildAbi({
  abi,
  cmakeBinary,
  ninjaBinary,
  ndkDir,
  llvmStripBinary,
}) {
  const buildDir = path.join(buildRoot, abi);
  const outputDir = path.join(libDir, abi);

  ensureCleanDirectory(buildDir);
  ensureCleanDirectory(outputDir);

  const configureArgs = [
    '-S',
    jniDir,
    '-B',
    buildDir,
    `-DANDROID_ABI=${abi}`,
    `-DANDROID_PLATFORM=android-${androidPlatform}`,
    '-DANDROID_STL=c++_static',
    `-DANDROID_NDK=${ndkDir}`,
    `-DCMAKE_TOOLCHAIN_FILE=${path.join(
      ndkDir,
      'build',
      'cmake',
      'android.toolchain.cmake',
    )}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_LIBRARY_OUTPUT_DIRECTORY=${outputDir}`,
    `-DCMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE=${outputDir}`,
  ];

  if (ninjaBinary) {
    configureArgs.push('-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninjaBinary}`);
  }

  console.log(`\n==> Configuring ${abi}`);
  run(cmakeBinary, configureArgs);

  const parallelism = Math.max(1, os.cpus().length);
  console.log(`==> Building ${abi}`);
  run(cmakeBinary, [
    '--build',
    buildDir,
    '--target',
    'rnupdate',
    '--config',
    'Release',
    '--parallel',
    String(parallelism),
  ]);

  ensureBuiltLibrary(outputDir);

  console.log(`==> Stripping ${abi}`);
  run(llvmStripBinary, ['--strip-unneeded', path.join(outputDir, 'librnupdate.so')]);
}

function main() {
  const ndkDir = resolveNdkDir();
  const cmakeBinary = resolveCmakeBinary();
  const ninjaBinary = resolveNinjaBinary(cmakeBinary);
  const llvmStripBinary = resolveLlvmStripBinary(ndkDir);

  console.log(`Using NDK: ${ndkDir}`);
  console.log(`Using CMake: ${cmakeBinary}`);
  if (ninjaBinary) {
    console.log(`Using Ninja: ${ninjaBinary}`);
  }
  console.log(`Using llvm-strip: ${llvmStripBinary}`);

  fs.mkdirSync(libDir, { recursive: true });

  for (const abi of abis) {
    configureAndBuildAbi({
      abi,
      cmakeBinary,
      ninjaBinary,
      ndkDir,
      llvmStripBinary,
    });
  }

  console.log('\nAndroid native libraries built successfully.');
}

try {
  main();
} catch (error) {
  console.error('\nAndroid native build failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
