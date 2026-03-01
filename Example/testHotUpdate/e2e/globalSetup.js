const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const detoxGlobalSetup = require('detox/runners/jest/globalSetup');
const { LOCAL_UPDATE_PORT } = require('./localUpdateConfig');

const projectRoot = path.resolve(__dirname, '..');
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
    'scripts/prepare-local-update-artifacts.js',
  );

  const result = spawnSync('node', [prepareScript], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to prepare local update artifacts, exit code: ${result.status}`,
    );
  }
}

function startServer() {
  const serverScript = path.join(projectRoot, 'scripts/local-artifacts-server.js');
  fs.mkdirSync(artifactsRoot, { recursive: true });

  const child = spawn('node', [serverScript], {
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

  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, res => {
        if (res.statusCode === 200) {
          resolve(void 0);
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

module.exports = async () => {
  const platform = process.env.E2E_PLATFORM || 'ios';
  if (!['ios', 'android'].includes(platform)) {
    throw new Error(`Unsupported E2E_PLATFORM: ${platform}`);
  }

  killExistingServer();
  runPrepareScript();
  startServer();
  await waitForServer();
  await detoxGlobalSetup();
};
