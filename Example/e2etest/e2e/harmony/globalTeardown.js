const fs = require('node:fs');
const path = require('node:path');

const pidFile = path.resolve(
  __dirname,
  '../../.e2e-artifacts/.server.harmony.pid',
);

module.exports = async function globalTeardown() {
  if (!fs.existsSync(pidFile)) {
    return;
  }
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid > 0) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // server already gone
  }
  fs.rmSync(pidFile, { force: true });
};
