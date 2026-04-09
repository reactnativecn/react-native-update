const path = require('path');
const { spawnSync } = require('child_process');

const { buildRoot, compileNodeTs, projectRoot } = require('./compile-node-ts');
const compiledEntry = path.join(
  buildRoot,
  'scripts/prepare-local-update-artifacts.js',
);

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

compileNodeTs();
run([compiledEntry]);
