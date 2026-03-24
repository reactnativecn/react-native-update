#!/usr/bin/env bun

import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'bun';

function normalizeVersion(version: string): string {
  return version.trim().replace(/^refs\/tags\//, '').replace(/^v/, '');
}

function getVersionFromEnvironment(): string | null {
  const candidates = [
    process.env.RELEASE_VERSION,
    process.env.CI_COMMIT_TAG,
    process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null,
    process.env.GITHUB_REF?.startsWith('refs/tags/')
      ? process.env.GITHUB_REF
      : null,
  ];

  for (const candidate of candidates) {
    if (candidate?.trim()) {
      return normalizeVersion(candidate);
    }
  }

  return null;
}

function getShellErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string' &&
    error.stderr.trim()
  ) {
    return error.stderr.trim();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return 'Unknown git error';
}

async function getVersionFromGit(): Promise<string> {
  try {
    return normalizeVersion(await $`git describe --tags --always`.text());
  } catch (error) {
    const message = getShellErrorMessage(error);

    if (message.includes('detected dubious ownership')) {
      throw new Error(
        'Git refused to read repository metadata because this checkout is not marked as safe. Configure safe.directory in CI or provide RELEASE_VERSION/GITHUB_REF_NAME.',
        { cause: error },
      );
    }

    throw new Error(`Unable to resolve publish version from git: ${message}`, {
      cause: error,
    });
  }
}

async function resolveVersion(): Promise<string> {
  return getVersionFromEnvironment() ?? (await getVersionFromGit());
}

async function modifyPackageJson({
  version,
}: {
  version: string;
}): Promise<void> {
  const packageJsonPath = path.join(__dirname, '..', 'package.json');

  try {
    await access(packageJsonPath);
  } catch {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  console.log('Reading package.json...');
  const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonContent);

  packageJson.version = version;

  console.log('Writing modified package.json...');

  await writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2),
    'utf-8',
  );

  console.log('package.json has been modified for publishing');
}

function isGitHubCI(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

function shouldSkipNativeBuild(): boolean {
  return process.argv.includes('--skip') || process.env.SKIP_NATIVE_BUILD === '1';
}

async function buildNativeArtifacts(): Promise<void> {
  console.log('Building Harmony HAR...');
  const harResult = Bun.spawnSync(['npm', 'run', 'build:harmony-har'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (harResult.exitCode !== 0) {
    throw new Error(
      `Harmony HAR build failed with exit code ${harResult.exitCode}`,
    );
  }

  console.log('Building Android SO...');
  const soResult = Bun.spawnSync(['npm', 'run', 'build:so'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (soResult.exitCode !== 0) {
    throw new Error(
      `Android SO build failed with exit code ${soResult.exitCode}`,
    );
  }
}

async function main(): Promise<void> {
  try {
    if (isGitHubCI()) {
      const version = await resolveVersion();
      console.log(`Using publish version ${version}`);
      await modifyPackageJson({ version });
    } else {
      console.log(
        'ℹ️  Not in GitHub CI, skipping version resolution and package.json modification',
      );
      if (shouldSkipNativeBuild()) {
        console.log(
          'ℹ️  --skip flag detected, skipping native artifacts build',
        );
      } else {
        await buildNativeArtifacts();
      }
    }

    console.log('✅ Prepublish script completed successfully');
  } catch (error) {
    console.error('❌ Prepublish script failed:', error);
    process.exit(1);
  }
}

main();
