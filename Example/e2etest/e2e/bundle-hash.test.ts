import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { device } from 'detox';

// bundleHash 铁律验收(BUNDLEHASH_MIGRATION.md §0/§2.7):客户端原生算出的
// bundleHash 必须与包内嵌入 bundle 的 sha256 逐字节一致——两侧对不上,服务端
// 就会确信 pdiff 可用而实际 hpatch 源校验失败,比 buildTime 启发式更糟。
//
// 无需 app 配合:JS 层(core.ts)在模块加载时预取 getBundleHash,原生算完后
// 缓存进 NSUserDefaults / SharedPreferences;宿主机直读缓存末段,与 Node 侧
// 对包内 bundle 算的 sha256 比对。
//
// Android 有独立的验证价值:它的哈希实现(MessageDigest)与被哈希字节的来源
// (AssetManager.open 对硬编码资产名)都与 iOS 不同——尤其后者,APK 条目可能
// 压缩存储,AssetManager 读出的解压字节必须等于 CLI 解包提取的条目字节。
const IOS_APP_PATH = path.resolve(
  __dirname,
  '../ios/build/Build/Products/Release-iphonesimulator/AwesomeProject.app',
);
const ANDROID_APK_PATH = path.resolve(
  __dirname,
  '../android/app/build/outputs/apk/release/app-release.apk',
);
const IOS_DEFAULTS_KEY = 'REACTNATIVECN_PUSHY_BUNDLEHASH_KEY';
const ANDROID_PREFS_KEY = 'bundleHashCache';
const POLL_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 1000;

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// 缓存格式 "cacheKey|hash",hash 恒为末段
function extractHash(raw: string): string | null {
  const hash = raw.split('|').pop() ?? '';
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function readIosCachedBundleHash(
  udid: string,
  bundleId: string,
): string | null {
  try {
    // app 容器的 NSUserDefaults 对 `simctl spawn defaults read` 不可见,
    // 必须定位容器后直接读 plist。
    const container = execSync(
      `xcrun simctl get_app_container ${udid} ${bundleId} data`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    const raw = execSync(
      `plutil -extract ${IOS_DEFAULTS_KEY} raw -o - "${container}/Library/Preferences/${bundleId}.plist"`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    return extractHash(raw);
  } catch {
    // 容器/plist/key 尚不存在:原生还没算完,继续轮询
    return null;
  }
}

let adbRooted = false;

function readAndroidCachedBundleHash(
  adbName: string,
  packageName: string,
): string | null {
  // release 包不可 run-as;模拟器(AOSP/Google APIs 镜像)上 adb root 后可
  // 直读 SharedPreferences xml。root 一次即可,幂等;Google Play 镜像会拒绝,
  // 此时退回 su 0(userdebug 镜像自带)。
  if (!adbRooted) {
    try {
      execSync(`adb -s ${adbName} root`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      execSync(`adb -s ${adbName} wait-for-device`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // 继续,读取时再退 su
    }
    adbRooted = true;
  }
  const prefsPath = `/data/data/${packageName}/shared_prefs/update.xml`;
  for (const cmd of [
    `adb -s ${adbName} shell cat ${prefsPath}`,
    `adb -s ${adbName} shell su 0 cat ${prefsPath}`,
  ]) {
    try {
      const xml = execSync(cmd, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const match = xml.match(
        new RegExp(`name="${ANDROID_PREFS_KEY}"[^>]*>([^<]+)<`),
      );
      if (match) {
        return extractHash(match[1]);
      }
      if (xml.includes('<map')) {
        // 读到了 prefs 但 key 还没写入:继续轮询
        return null;
      }
    } catch {
      // 尝试下一条读取路径
    }
  }
  return null;
}

describe('bundleHash content identity', () => {
  it('natively computed bundleHash equals sha256 of the embedded bundle', async () => {
    const platform = device.getPlatform();

    let expected: string;
    let readActual: () => string | null;

    if (platform === 'ios') {
      const bundlePath = path.join(IOS_APP_PATH, 'main.jsbundle');
      if (!existsSync(bundlePath)) {
        throw new Error(`embedded bundle not found at ${bundlePath}`);
      }
      expected = sha256Hex(readFileSync(bundlePath));
      const bundleId = execSync(
        `/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${IOS_APP_PATH}/Info.plist"`,
      )
        .toString()
        .trim();
      readActual = () => readIosCachedBundleHash(device.id, bundleId);
    } else if (platform === 'android') {
      if (!existsSync(ANDROID_APK_PATH)) {
        throw new Error(`release apk not found at ${ANDROID_APK_PATH}`);
      }
      // 提取的是 zip 条目的原始内容字节(unzip -p 自动解压)——与客户端
      // AssetManager.open 返回的字节、CLI getApkInfo 提取的字节同源。
      expected = sha256Hex(
        execSync(`unzip -p "${ANDROID_APK_PATH}" assets/index.android.bundle`, {
          maxBuffer: 256 * 1024 * 1024,
        }),
      );
      // applicationId 固定(android/app/build.gradle),无需解析二进制 manifest
      readActual = () =>
        readAndroidCachedBundleHash(device.id, 'com.awesomeproject');
    } else {
      // Harmony 走独立 runner,不经 detox。
      return;
    }

    if (platform === 'android') {
      // 不走 device.launchApp:本用例不做任何 UI 交互,不需要 detox 的
      // app 会话,而 launchApp 的 websocket 握手在部分环境(本机 arm64
      // 模拟器)下会挂起。detox 已负责分配模拟器与安装 APK,adb 直接拉起
      // 进程即可;数据被 init 重装清空,恰好覆盖"全新安装首次计算"路径。
      execSync(
        `adb -s ${device.id} shell monkey -p com.awesomeproject -c android.intent.category.LAUNCHER 1`,
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
    } else {
      await device.launchApp({ newInstance: true });
    }

    // JS 启动即预取 → 原生后台懒计算并写缓存;轮询等它落盘
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let actual: string | null = null;
    while (Date.now() < deadline) {
      actual = readActual();
      if (actual) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (!actual) {
      throw new Error(
        `native bundleHash was not cached within ${POLL_TIMEOUT_MS}ms — ` +
          'is the JS prefetch (core.ts) running and the native method present?',
      );
    }
    // 显式比较:detox 的 jest 环境把全局 expect 换成了元素断言版,不能对普通
    // 值用 .toBe。
    if (actual !== expected) {
      throw new Error(
        `bundleHash mismatch — native computed ${actual}, ` +
          `sha256 of the embedded bundle is ${expected}`,
      );
    }
  });
});
