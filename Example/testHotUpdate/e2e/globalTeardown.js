const fs = require('fs');
const path = require('path');
const detoxGlobalTeardown = require('detox/runners/jest/globalTeardown');

const projectRoot = path.resolve(__dirname, '..');
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

module.exports = async () => {
  try {
    await detoxGlobalTeardown();
  } finally {
    stopServer();
  }
};
