#!/usr/bin/env node
/**
 * Standalone wrapper to invoke the CLI's diff commands with proper module resolution.
 * Usage: run-hdiff-wrapper.js <cliRoot> <command> <origin> <next> <output>
 *   where command is 'hdiff' or 'hdiffFromApk'
 */

const path = require('path');
const fs = require('fs');

const cliRoot = process.argv[2];
const command = process.argv[3];
const origin = process.argv[4];
const next = process.argv[5];
const output = process.argv[6];

if (!cliRoot || !command || !origin || !next || !output) {
  console.error('Usage: run-hdiff-wrapper.js <cliRoot> <command> <origin> <next> <output>');
  process.exit(1);
}

// Load the CLI's diff module with proper paths
process.env.NODE_PATH = [
  path.join(process.cwd(), 'node_modules'),
  path.join(cliRoot, 'node_modules'),
].join(path.delimiter);

// Re-initialize module paths
require('module').Module._initPaths();

// Now require the CLI's diff module
const diff = require(path.join(cliRoot, 'lib/diff'));

// Get the command handler
const handler = diff.diffCommands[command];

if (!handler) {
  console.error(`Command handler '${command}' not found in CLI diff module`);
  process.exit(1);
}

// Call the handler directly
handler({
  args: [origin, next],
  options: { output, 'no-interactive': true },
}).then(() => {
  if (fs.existsSync(output)) {
    console.log(`${command} output created: ${output} (${fs.statSync(output).size} bytes)`);
  } else {
    console.error(`${command} output NOT created: ${output}`);
    process.exit(1);
  }
}).catch(err => {
  console.error(`${command} failed:`, err);
  process.exit(1);
});
