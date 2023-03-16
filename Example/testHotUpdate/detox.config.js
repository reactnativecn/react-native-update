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
    'ios.release': {
      type: 'ios.app',
      binaryPath:
        'ios/build/Build/Products/Release-iphonesimulator/testHotUpdate.app',
      build:
        'export RCT_NO_LAUNCH_PACKAGER=true && xcodebuild -workspace ios/testHotUpdate.xcworkspace -UseNewBuildSystem=NO -scheme testHotUpdate -configuration Release -sdk iphonesimulator -derivedDataPath ios/build -quiet',
    },
    'android.release': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/release/app-release.apk',
      build:
        'cd android ; ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release ; cd -',
    },
  },
  devices: {
    simulator: {
      type: 'ios.simulator',
      headless: Boolean(process.env.CI),
      device: {
        type: 'iPhone 14',
      },
    },
    emulator: {
      type: 'android.emulator',
      headless: Boolean(process.env.CI),
      gpuMode: process.env.CI ? 'off' : undefined,
      device: {
        avdName: 'Pixel_3a_API_33_arm64-v8a',
      },
      utilBinaryPaths: ['./cache/test-butler-app.apk'],
    },
    'genymotion.emulator.uuid': {
      type: 'android.genycloud',
      device: {
        recipeUUID: 'a50a71d6-da90-4c67-bdfa-5b602b0bbd15',
      },
      utilBinaryPaths: ['./cache/test-butler-app.apk'],
    },
    'genymotion.emulator.name': {
      type: 'android.genycloud',
      device: {
        recipeName: 'Pixel_3a_API_33_arm64-v8a',
      },
      utilBinaryPaths: ['./cache/test-butler-app.apk'],
    },
  },
  configurations: {
    'ios.sim.release': {
      device: 'simulator',
      app: 'ios.release',
    },
    'ios.sim.debug': {
      device: 'simulator',
      app: 'ios.debug',
    },
    'ios.manual': {
      type: 'ios.manual',
      behavior: {
        launchApp: 'manual',
      },
      artifacts: false,
      session: {
        autoStart: true,
        server: 'ws://localhost:8099',
        sessionId: 'com.wix.demo.react.native',
      },
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
