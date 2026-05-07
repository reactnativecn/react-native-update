#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RN_VERSION = '0.77.3';
const RN_CLI_VERSION = '15.0.1';
const appName = 'AwesomeProject';
const scriptDir = __dirname;
const baseE2eDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(baseE2eDir, '../..');
const workspaceRoot = path.resolve(
  process.env.RNU_RN077_OLDARCH_ROOT ||
    path.join(repoRoot, '.e2e-rn077-oldarch'),
);
const projectRoot = path.join(workspaceRoot, appName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}`,
    );
  }
}

function copyFromBase(relativePath) {
  fs.cpSync(path.join(baseE2eDir, relativePath), path.join(projectRoot, relativePath), {
    recursive: true,
    force: true,
  });
}

function readText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function writeText(relativePath, content) {
  fs.writeFileSync(path.join(projectRoot, relativePath), content);
}

function createReactNativeProject() {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  run(
    'npx',
    [
      `@react-native-community/cli@${RN_CLI_VERSION}`,
      'init',
      appName,
      '--version',
      RN_VERSION,
      '--skip-install',
    ],
    { cwd: workspaceRoot },
  );

  fs.rmSync(path.join(projectRoot, '.git'), { recursive: true, force: true });
}

function copyE2eHarness() {
  [
    '.detoxrc.js',
    '.detoxrc.ts',
    '.eslintrc.js',
    '.prettierrc.js',
    '.watchmanconfig',
    'app.json',
    'e2e',
    'index.js',
    'jest.config.js',
    'jest.setup.js',
    'metro.config.js',
    'scripts',
    'src',
    'tsconfig.json',
    'tsconfig.node.json',
    'update.json',
  ].forEach(copyFromBase);

  writeText(
    'babel.config.js',
    "module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n};\n",
  );
}

function writePackageJson() {
  const generatedPackageJson = JSON.parse(readText('package.json'));

  const packageJson = {
    name: 'e2etest-rn077-oldarch',
    version: generatedPackageJson.version,
    private: true,
    scripts: {
      android: 'react-native run-android',
      ios: 'react-native run-ios',
      start: 'react-native start',
      test: 'jest',
      server: 'bun scripts/local-e2e-server.ts',
      'prepare:e2e': 'node scripts/run-prepare-local-update-artifacts.js',
      'test:e2e:android':
        'E2E_PLATFORM=android detox test --configuration android.emu.release --headless --record-logs all',
      lint: 'eslint .',
      apk: 'cd android && ./gradlew assembleRelease',
    },
    dependencies: {
      react: '18.3.1',
      'react-native': RN_VERSION,
      'react-native-update': '^10.40.0',
    },
    devDependencies: {
      ...generatedPackageJson.devDependencies,
      '@types/node': '^24.6.0',
      detox: '20.50.1',
      'ts-node': '^10.9.2',
    },
    engines: {
      node: '>=22',
    },
    trustedDependencies: ['detox', 'dtrace-provider'],
  };

  writeText('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
}

function configureAndroidOldArchitecture() {
  let gradleProperties = readText('android/gradle.properties');
  gradleProperties = gradleProperties.replace(
    /^newArchEnabled=.*$/m,
    'newArchEnabled=false',
  );
  writeText('android/gradle.properties', gradleProperties);

  let appBuildGradle = readText('android/app/build.gradle');
  appBuildGradle = appBuildGradle.replace(
    /versionName "1\.0"/,
    [
      'versionName "1.0"',
      "        testBuildType System.getProperty('testBuildType', 'debug')",
      '        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"',
    ].join('\n'),
  );
  appBuildGradle = appBuildGradle.replace(
    /release \{\n\s+\/\/ Caution!/,
    'release {\n            crunchPngs false\n            // Caution!',
  );
  appBuildGradle = appBuildGradle.replace(
    /dependencies \{\n/,
    [
      'def detoxVersion = "20.50.1"',
      '',
      'repositories {',
      '    maven {',
      '        url("$rootDir/../node_modules/detox/Detox-android")',
      '    }',
      '}',
      '',
      'dependencies {',
    ].join('\n') + '\n',
  );
  appBuildGradle = appBuildGradle.replace(
    /implementation\("com\.facebook\.react:react-android"\)\n/,
    [
      'implementation("com.facebook.react:react-android")',
      '',
      '    androidTestImplementation("com.wix:detox:${detoxVersion}")',
      '    androidTestImplementation("junit:junit:4.13.2")',
      '    androidTestImplementation("androidx.test:runner:1.6.2")',
      '    androidTestImplementation("androidx.test:rules:1.6.1")',
      '    androidTestImplementation("androidx.test.ext:junit:1.2.1")',
      '',
    ].join('\n'),
  );
  writeText('android/app/build.gradle', appBuildGradle);

  copyFromBase('android/app/src/androidTest/java/com/awesomeproject/DetoxTest.java');
  copyFromBase('android/app/src/main/res/xml/network_security_config.xml');

  let manifest = readText('android/app/src/main/AndroidManifest.xml');
  manifest = manifest.replace(
    /android:theme="@style\/AppTheme"/,
    [
      'android:theme="@style/AppTheme"',
      '      android:networkSecurityConfig="@xml/network_security_config"',
    ].join('\n'),
  );
  writeText('android/app/src/main/AndroidManifest.xml', manifest);

  let mainApplication = readText(
    'android/app/src/main/java/com/awesomeproject/MainApplication.kt',
  );
  mainApplication = mainApplication.replace(
    'import com.facebook.soloader.SoLoader\n',
    [
      'import com.facebook.soloader.SoLoader',
      'import cn.reactnative.modules.update.UpdateContext',
      '',
    ].join('\n'),
  );
  mainApplication = mainApplication.replace(
    '        override fun getJSMainModuleName(): String = "index"\n',
    [
      '        override fun getJSMainModuleName(): String = "index"',
      '',
      '        override fun getJSBundleFile(): String? = UpdateContext.getBundleUrl(this@MainApplication)',
      '',
    ].join('\n'),
  );
  writeText(
    'android/app/src/main/java/com/awesomeproject/MainApplication.kt',
    mainApplication,
  );
}

function main() {
  createReactNativeProject();
  copyE2eHarness();
  writePackageJson();
  configureAndroidOldArchitecture();
  console.log(`Created RN ${RN_VERSION} old architecture e2e project: ${projectRoot}`);
}

main();
