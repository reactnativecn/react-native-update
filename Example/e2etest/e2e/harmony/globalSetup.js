const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PORT = 31337;
const projectRoot = path.resolve(__dirname, '../..');
const artifactsRoot = path.join(projectRoot, '.e2e-artifacts');
const pidFile = path.join(artifactsRoot, '.server.harmony.pid');

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
  const result = spawnSync(process.execPath, [prepareScript], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, E2E_PLATFORM: 'harmony' },
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to prepare harmony update artifacts, exit code: ${result.status}`,
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
    env: { ...process.env, E2E_ASSET_PORT: String(PORT) },
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
}

function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  const url = `http://127.0.0.1:${PORT}/health`;
  return new Promise((resolve, reject) => {
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
        reject(new Error('Local artifacts server did not become ready.'));
        return;
      }
      setTimeout(poll, 300);
    };
    poll();
  });
}

module.exports = async function globalSetup() {
  killExistingServer();
  if (process.env.RNU_E2E_SKIP_PREPARE === 'true') {
    const manifest = path.join(artifactsRoot, 'harmony/manifest.json');
    if (!fs.existsSync(manifest)) {
      throw new Error(`Harmony update artifacts are missing: ${manifest}`);
    }
  } else {
    runPrepareScript();
  }
  startServer();
  await waitForServer();
};
