#!/usr/bin/env node
/**
 * run-hdiff-wrapper.js
 * Directly invoke CLI's diff handlers with node-hdiffpatch pre-loaded.
 * Bypasses CLI bin.ts and the loadModule resolution issue.
 *
 * Usage: node run-hdiff-wrapper.js <cliRoot> <ppk|apk> <old> <new> <output>
 */

const path = require('path');
const fs = require('fs');

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

if (!fs.existsSync(oldPath)) {
  console.error(`[hdiff-wrapper] ERROR: old file not found: ${oldPath}`);
  process.exit(1);
}
if (!fs.existsSync(newPath)) {
  console.error(`[hdiff-wrapper] ERROR: new file not found: ${newPath}`);
  process.exit(1);
}

// Pre-load node-hdiffpatch from project's node_modules (cwd = projectRoot)
let hdiffModule;
try {
  hdiffModule = require('node-hdiffpatch');
  console.log(`[hdiff-wrapper] node-hdiffpatch loaded: ${typeof hdiffModule}, keys: ${Object.keys(hdiffModule).join(', ')}`);
} catch (err) {
  console.error(`[hdiff-wrapper] ERROR: Failed to load node-hdiffpatch: ${err.message}`);
  process.exit(1);
}

// Load CLI's diff module using absolute path
const diffModule = require(path.join(cliRoot, 'lib/diff'));
const { diffCommands } = diffModule;
console.log(`[hdiff-wrapper] diffCommands: ${Object.keys(diffCommands).join(', ')}`);

(async () => {
  try {
    // Pass customHdiffModule so CLI doesn't need to resolve it via loadModule
    const options = { output: outputPath, 'no-interactive': true, customHdiffModule: hdiffModule };

    if (mode === 'ppk') {
      console.log(`[hdiff-wrapper] Calling diffCommands.hdiff...`);
      await diffCommands.hdiff({ args: [oldPath, newPath], options });
    } else if (mode === 'apk') {
      console.log(`[hdiff-wrapper] Calling diffCommands.hdiffFromApk...`);
      await diffCommands.hdiffFromApk({ args: [oldPath, newPath], options });
    } else {
      console.error(`[hdiff-wrapper] ERROR: Unknown mode: ${mode}`);
      process.exit(1);
    }

    if (fs.existsSync(outputPath)) {
      console.log(`[hdiff-wrapper] SUCCESS: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
    } else {
      console.error(`[hdiff-wrapper] ERROR: Output file not created: ${outputPath}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[hdiff-wrapper] ERROR: ${err.message}`);
    if (err.stack) console.error(`[hdiff-wrapper] Stack: ${err.stack}`);
    process.exit(1);
  }
})();
