// iOS 模拟器探测,.detoxrc.js 与 CI 预热步骤共用同一份逻辑——
// 两处各写一份曾导致预热 boot 了 detox 不用的设备(同名设备横跨多个
// runtime,shell 版取了旧 runtime 的实例),白等一次冷启动。
const { execSync } = require('node:child_process');

function detectIosSimulatorType() {
  if (process.env.DETOX_IOS_DEVICE_TYPE) {
    return process.env.DETOX_IOS_DEVICE_TYPE;
  }

  if (process.platform !== 'darwin') {
    return 'iPhone 14';
  }

  try {
    const output = execSync('xcrun simctl list devices available', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();

    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // Strip the trailing "(UDID) (State)" instead of cutting at the first
    // " (" — device names can themselves contain parentheses, e.g.
    // "iPhone SE (3rd generation)".
    const extractName = (line) =>
      line.replace(/\s*\([0-9A-Fa-f-]{36}\).*$/, '').trim();

    const preferredPrefixes = [
      'iPhone 17',
      'iPhone 16',
      'iPhone 15',
      'iPhone 14',
    ];

    for (const prefix of preferredPrefixes) {
      const line = lines.find(
        (item) => item.startsWith(prefix) && item.includes('(')
      );
      if (line) {
        return extractName(line);
      }
    }

    const fallbackLine = lines.find(
      (item) => item.startsWith('iPhone ') && item.includes('(')
    );
    if (fallbackLine) {
      return extractName(fallbackLine);
    }
  } catch {
    // fall through to default
  }

  return 'iPhone 14';
}

// 探测型号在最新 runtime 下的具体设备 UDID(与 applesimutils 的挑选
// 倾向一致),供 CI 预热用;找不到返回空串,调用方自行放弃预热。
function detectBootTargetUdid() {
  const name = detectIosSimulatorType();
  try {
    const json = JSON.parse(
      execSync('xcrun simctl list devices available --json', {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString()
    );
    // runtime key 形如 com.apple.CoreSimulator.SimRuntime.iOS-26-5,
    // 取版本号最大的 runtime 里第一台同名可用设备
    const runtimes = Object.keys(json.devices)
      .filter((key) => /SimRuntime\.iOS-/.test(key))
      .sort((a, b) => {
        const ver = (key) =>
          key
            .replace(/^.*iOS-/, '')
            .split('-')
            .map(Number);
        const [aMaj, aMin = 0] = ver(a);
        const [bMaj, bMin = 0] = ver(b);
        return bMaj - aMaj || bMin - aMin;
      });
    for (const runtime of runtimes) {
      const device = json.devices[runtime].find(
        (item) => item.name === name && item.isAvailable
      );
      if (device) {
        return device.udid;
      }
    }
  } catch {
    // fall through
  }
  return '';
}

module.exports = { detectIosSimulatorType, detectBootTargetUdid };

if (require.main === module) {
  process.stdout.write(
    process.argv.includes('--udid')
      ? detectBootTargetUdid()
      : detectIosSimulatorType()
  );
}
