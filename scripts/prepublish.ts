#!/usr/bin/env bun

import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'bun';

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

async function main(): Promise<void> {
  const version = (await $`git describe --tags --always`.text())
    .replace('v', '')
    .trim();
  try {
    await modifyPackageJson({ version });
    console.log('✅ Prepublish script completed successfully');
  } catch (error) {
    console.error('❌ Prepublish script failed:', error);
    process.exit(1);
  }

}

main();
