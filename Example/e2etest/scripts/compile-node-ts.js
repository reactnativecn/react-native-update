const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const buildRoot = path.join(projectRoot, '.e2e-artifacts/.ts-build');
const tscCli = path.join(projectRoot, 'node_modules/typescript/bin/tsc');
const tsConfigPath = path.join(projectRoot, 'tsconfig.node.json');

function compileNodeTs() {
  const result = spawnSync(
    process.execPath,
    [tscCli, '-p', tsConfigPath, '--outDir', buildRoot],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to compile Node-side TS files, exit code: ${result.status}`);
  }

  return buildRoot;
}

module.exports = {
  buildRoot,
  compileNodeTs,
  projectRoot,
  tsConfigPath,
};

if (require.main === module) {
  compileNodeTs();
}
