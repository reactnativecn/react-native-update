const { execSync } = require('child_process');

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
      .map(line => line.trim())
      .filter(Boolean);

    const preferredPrefixes = ['iPhone 17', 'iPhone 16', 'iPhone 15', 'iPhone 14'];

    for (const prefix of preferredPrefixes) {
      const line = lines.find(item => item.startsWith(prefix) && item.includes('('));
      if (line) {
        return line.split(' (')[0];
      }
    }

    const fallbackLine = lines.find(item => item.startsWith('iPhone ') && item.includes('('));
    if (fallbackLine) {
      return fallbackLine.split(' (')[0];
    }
  } catch {
    // fall through to default
  }

  return 'iPhone 14';
}

const iosSimulatorType = detectIosSimulatorType();

function detectAndroidAvdName() {
  if (process.env.DETOX_AVD_NAME) {
    return process.env.DETOX_AVD_NAME;
  }

  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return 'Pixel_3a_API_33_arm64-v8a';
  }

  try {
    const output = execSync('emulator -list-avds', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const avds = output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (avds.length > 0) {
      return avds[0];
    }
  } catch {
    // fall through to default
  }

  return 'Pixel_3a_API_33_arm64-v8a';
}

const androidAvdName = detectAndroidAvdName();

/** @type {Detox.DetoxConfig} */
module.exports = {
  logger: {
    level: process.env.CI ? 'debug' : undefined,
  },
  testRunner: {
    args: {
      config: 'e2e/jest.config.js',
      maxWorkers: process.env.CI ? 2 : undefined,
      _: ['e2e'],
    },
  },
  artifacts: {
    plugins: {
      log: process.env.CI ? 'failing' : undefined,
      screenshot: process.env.CI ? 'failing' : undefined,
    },
  },
  apps: {
    'ios.debug': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Debug-iphonesimulator/AwesomeProject.app',
      build: "xcodebuild -workspace ios/AwesomeProject.xcworkspace -UseNewBuildSystem=NO -scheme AwesomeProject -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build",
      start: "scripts/start-rn.sh ios",
    },
    'ios.release': {
      type: 'ios.app',
      binaryPath:
        'ios/build/Build/Products/Release-iphonesimulator/AwesomeProject.app',
        build:
        'export RCT_NO_LAUNCH_PACKAGER=true && xcodebuild -workspace ios/AwesomeProject.xcworkspace -UseNewBuildSystem=NO -scheme AwesomeProject -configuration Release -sdk iphonesimulator -derivedDataPath ios/build -quiet',
    },
    'android.debug': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/debug/app-debug.apk',
      build:
        'cd android && ./gradlew assembleDebug assembleAndroidTest -DtestBuildType=debug',
      start: "scripts/start-rn.sh android",
      reversePorts: [8081],
    },
    'android.release': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/release/app-release.apk',
      build:
        'cd android && ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release',
    },
  },
  devices: {
    simulator: {
      type: 'ios.simulator',
      device: {
        type: iosSimulatorType,
      },
    },
    attached: {
      type: 'android.attached',
      device: {
        adbName: '.*',
      },
    },
    emulator: {
      type: 'android.emulator',
      device: {
        avdName: androidAvdName,
      },
    },
  },
  configurations: {
    'ios.sim.debug': {
      device: 'simulator',
      app: 'ios.debug',
    },
    'ios.sim.release': {
      device: 'simulator',
      app: 'ios.release',
    },
    'android.att.debug': {
      device: 'attached',
      app: 'android.debug',
    },
    'android.att.release': {
      device: 'attached',
      app: 'android.release',
    },
    'android.emu.debug': {
      device: 'emulator',
      app: 'android.debug',
    },
    'android.emu.release': {
      device: 'emulator',
      app: 'android.release',
    },
  },
};
