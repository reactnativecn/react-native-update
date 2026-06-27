#!/usr/bin/env node
/**
 * run-hdiff-wrapper.js
 * Directly require CLI's diff module to generate hdiff patches.
 * Bypasses the pushy CLI entirely (avoids bin.ts argument parsing issues).
 * 
 * Usage:
 *   node run-hdiff-wrapper.js <cliRoot> <ppk|apk> <old> <new> <output>
 */

const { existsSync, statSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { createRequire } = require('node:module');

const [cliRoot, mode, oldPath, newPath, outputPath] = process.argv.slice(2);

if (!cliRoot || !mode || !oldPath || !newPath || !outputPath) {
  console.error('Usage: node run-hdiff-wrapper.js <cliRoot> <ppk|apk> <old> <new> <output>');
  process.exit(1);
}

console.log(`[hdiff-wrapper] cliRoot=${cliRoot}`);
console.log(`[hdiff-wrapper] mode=${mode}`);
console.log(`[hdiff-wrapper] old=${oldPath}`);
console.log(`[hdiff-wrapper] new=${newPath}`);
console.log(`[hdiff-wrapper] output=${outputPath}`);

if (!existsSync(oldPath)) {
  console.error(`[hdiff-wrapper] ERROR: old file not found: ${oldPath}`);
  process.exit(1);
}
if (!existsSync(newPath)) {
  console.error(`[hdiff-wrapper] ERROR: new file not found: ${newPath}`);
  process.exit(1);
}

// Load diff module directly from CLI's lib directory
const cliPkg = require(resolve(cliRoot, 'package.json'));
const mainEntry = cliPkg.main || 'lib/index.js';
const libDir = resolve(cliRoot, dirname(mainEntry));

console.log(`[hdiff-wrapper] libDir=${libDir}`);

// Set NODE_PATH so loadModule('node-hdiffpatch') can find it
const projectRoot = resolve(__dirname, '..', '..', '..');
const nodePathDirs = [
  resolve(projectRoot, 'node_modules'),
  resolve(cliRoot, 'node_modules'),
];
if (process.env.NODE_PATH) {
  nodePathDirs.push(process.env.NODE_PATH);
}
process.env.NODE_PATH = nodePathDirs.join(':');
console.log(`[hdiff-wrapper] NODE_PATH=${process.env.NODE_PATH}`);

// Require the diff module directly
const requireFromLib = createRequire(resolve(libDir, '__placeholder.js'));
const diffModule = requireFromLib('./diff');
const { diffCommands } = diffModule;

console.log(`[hdiff-wrapper] diffCommands: ${Object.keys(diffCommands).join(', ')}`);

(async () => {
  try {
    if (mode === 'ppk') {
      console.log(`[hdiff-wrapper] Calling diffCommands.hdiff...`);
      await diffCommands.hdiff(oldPath, newPath, outputPath);
    } else if (mode === 'apk') {
      console.log(`[hdiff-wrapper] Calling diffCommands.hdiffFromApk...`);
      await diffCommands.hdiffFromApk(oldPath, newPath, outputPath);
    } else {
      console.error(`[hdiff-wrapper] ERROR: Unknown mode: ${mode}`);
      process.exit(1);
    }

    if (existsSync(outputPath)) {
      console.log(`[hdiff-wrapper] SUCCESS: ${outputPath} (${statSync(outputPath).size} bytes)`);
    } else {
      console.error(`[hdiff-wrapper] ERROR: Output file not created: ${outputPath}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[hdiff-wrapper] ERROR: ${err.message}`);
    console.error(`[hdiff-wrapper] Stack: ${err.stack}`);
    process.exit(1);
  }
})();
