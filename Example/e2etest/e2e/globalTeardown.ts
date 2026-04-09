import * as fs from 'node:fs';
import * as path from 'node:path';
const detoxGlobalTeardown: () => Promise<void> = require(
  'detox/runners/jest/globalTeardown.js',
);

function findProjectRoot(...startDirs: string[]) {
  for (const startDir of startDirs) {
    let currentDir = path.resolve(startDir);
    while (true) {
      const hasMarkers =
        fs.existsSync(path.join(currentDir, 'package.json')) &&
        fs.existsSync(path.join(currentDir, 'scripts/run-prepare-local-update-artifacts.js')) &&
        fs.existsSync(path.join(currentDir, 'scripts/local-e2e-server.ts'));

      if (hasMarkers) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  throw new Error('Unable to resolve the e2etest project root.');
}

const projectRoot = findProjectRoot(process.cwd(), __dirname);
const pidFile = path.join(projectRoot, '.e2e-artifacts/.server.pid');

function stopServer() {
  if (!fs.existsSync(pidFile)) {
    return;
  }

  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid > 0) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // ignore stale pid
  }

  fs.rmSync(pidFile, { force: true });
}

async function globalTeardown() {
  try {
    await detoxGlobalTeardown();
  } finally {
    stopServer();
  }
}

export default globalTeardown;
