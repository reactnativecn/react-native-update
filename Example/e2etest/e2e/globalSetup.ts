import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LOCAL_UPDATE_PORT } from './localUpdateConfig';

const detoxGlobalSetup: () => Promise<void> = require(
  'detox/runners/jest/globalSetup.js',
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
const artifactsRoot = path.join(projectRoot, '.e2e-artifacts');
const pidFile = path.join(artifactsRoot, '.server.pid');

function killExistingServer() {
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
}

function runPrepareScript() {
  const prepareScript = path.join(
    projectRoot,
    'scripts/run-prepare-local-update-artifacts.js',
  );

  const result = spawnSync(
    process.execPath,
    [prepareScript],
    {
      // Use Node here because the local CLI depends on native addons that are
      // built for Node rather than Bun.
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to prepare local update artifacts, exit code: ${result.status}`,
    );
  }
}

function ensurePreparedArtifacts(platform: string) {
  const manifestPath = path.join(artifactsRoot, platform, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `RNU_E2E_SKIP_PREPARE is set, but local update artifacts are missing: ${manifestPath}`,
    );
  }
}

function startServer() {
  const serverScript = path.join(projectRoot, 'scripts/local-e2e-server.ts');
  fs.mkdirSync(artifactsRoot, { recursive: true });

  const child = spawn('bun', [serverScript], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      E2E_ASSET_PORT: String(LOCAL_UPDATE_PORT),
    },
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
}

function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  const url = `http://127.0.0.1:${LOCAL_UPDATE_PORT}/health`;

  return new Promise<void>((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, res => {
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Local artifacts server did not become ready in time.'));
        return;
      }
      setTimeout(poll, 300);
    };

    poll();
  });
}

async function globalSetup() {
  const platform = process.env.E2E_PLATFORM || 'ios';
  if (!['ios', 'android'].includes(platform)) {
    throw new Error(`Unsupported E2E_PLATFORM: ${platform}`);
  }

  killExistingServer();
  if (process.env.RNU_E2E_SKIP_PREPARE === 'true') {
    ensurePreparedArtifacts(platform);
  } else {
    runPrepareScript();
  }
  startServer();
  await waitForServer();
  await detoxGlobalSetup();
}

export default globalSetup;
