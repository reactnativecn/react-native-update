#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

async function appendMetadataToHBC(hbcPath, contentHash) {
  if (!fs.existsSync(hbcPath)) {
    console.error(`[Process HBC] File not found: ${hbcPath}`);
    return false;
  }

  const hbcBuffer = await fs.promises.readFile(hbcPath);

  const metadata = {
    contentHash
  };
  const metadataJson = JSON.stringify(metadata);

  const MAGIC = Buffer.from('RNUPDATE', 'utf8');
  const jsonBuffer = Buffer.from(metadataJson, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(jsonBuffer.length);

  const finalBuffer = Buffer.concat([
    hbcBuffer,
    MAGIC,
    jsonBuffer,
    lengthBuffer,
    MAGIC,
  ]);

  await fs.promises.writeFile(hbcPath, finalBuffer);
  console.log(`[Process HBC] ✅ Appended metadata to: ${hbcPath}`);
  console.log(`[Process HBC] Hash: ${contentHash.slice(0, 16)}...`);
  return true;
}

function getIOSProjectName() {
  try {
    const iosDir = path.join(PROJECT_ROOT, 'ios');
    if (fs.existsSync(iosDir)) {
      const files = fs.readdirSync(iosDir);
      const xcodeprojFile = files.find(f => f.endsWith('.xcodeproj'));
      if (xcodeprojFile) {
        return xcodeprojFile.replace('.xcodeproj', '');
      }
    }

    const packageJsonPath = path.join(PROJECT_ROOT, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return packageJson.name || '';
    }
  } catch (error) {
    console.warn('[Process HBC] Failed to detect iOS project name:', error.message);
  }

  return '';
}

function findHbcFiles(platform) {
  const hbcFiles = [];

  if (platform === 'android') {
    const possiblePaths = [
      'android/app/build/generated/assets/react/release/index.android.bundle',
      'android/app/build/generated/assets/createBundleReleaseJsAndAssets/index.android.bundle',
      'android/app/src/main/assets/index.android.bundle',
    ];

    for (const p of possiblePaths) {
      const fullPath = path.join(PROJECT_ROOT, p);
      if (fs.existsSync(fullPath)) {
        hbcFiles.push(fullPath);
      }
    }
  } else if (platform === 'ios') {
    const projectName = getIOSProjectName();
    console.log(`[Process HBC] Detected iOS project name: ${projectName}`);

    const possiblePaths = [
      `ios/${projectName}.app/main.jsbundle`,
      `ios/build/Build/Products/Release-iphoneos/${projectName}.app/main.jsbundle`,
      `ios/build/Build/Products/Debug-iphoneos/${projectName}.app/main.jsbundle`,
      'ios/main.jsbundle',
      'ios/build/Build/Products/Release-iphoneos/main.jsbundle',
    ];

    for (const p of possiblePaths) {
      const fullPath = path.join(PROJECT_ROOT, p);
      if (fs.existsSync(fullPath)) {
        hbcFiles.push(fullPath);
      }
    }

    if (hbcFiles.length === 0) {
      const iosDir = path.join(PROJECT_ROOT, 'ios');
      if (fs.existsSync(iosDir)) {
        const appDirs = fs.readdirSync(iosDir).filter(f => f.endsWith('.app'));
        for (const appDir of appDirs) {
          const jsbundlePath = path.join(iosDir, appDir, 'main.jsbundle');
          if (fs.existsSync(jsbundlePath)) {
            hbcFiles.push(jsbundlePath);
          }
        }
      }
    }
  }

  return hbcFiles;
}

async function main() {
  const platform = process.argv[2] || 'android';
  console.log(`[Process HBC] Platform: ${platform}`);
  console.log(`[Process HBC] Project root: ${PROJECT_ROOT}`);
  const hashFilePath = path.join(PROJECT_ROOT, 'bundle-hash.json');

  if (!fs.existsSync(hashFilePath)) {
    console.error(`[Process HBC] ❌ Hash file not found: ${hashFilePath}`);
    console.error('[Process HBC] Make sure Metro bundler has run with the custom serializer.');
    process.exit(1);
  }
  const hashData = JSON.parse(fs.readFileSync(hashFilePath, 'utf8'));
  const { contentHash } = hashData;
  console.log(`[Process HBC] Content hash: ${contentHash.slice(0, 16)}...`);
  const hbcFiles = findHbcFiles(platform);
  if (hbcFiles.length === 0) {
    console.error(`[Process HBC] ❌ No HBC files found for platform: ${platform}`);
    console.error('[Process HBC] Expected locations:');
    if (platform === 'android') {
      console.error('  - android/app/build/generated/assets/react/release/');
      console.error('  - android/app/src/main/assets/');
    } else {
      console.error('  - ios/build/Build/Products/Release-iphoneos/');
      console.error('  - ios/');
    }
    process.exit(1);
  }

  let successCount = 0;
  for (const hbcPath of hbcFiles) {
    const success = await appendMetadataToHBC(hbcPath, contentHash);
    if (success) successCount++;
  }

  console.log(`\n[Process HBC] ✅ Processed ${successCount}/${hbcFiles.length} HBC files`);

  try {
    fs.unlinkSync(hashFilePath);
    console.log(`[Process HBC] Cleaned up hash file`);
  } catch (error) {
  }
}

main().catch(error => {
  console.error('[Process HBC] ❌ Error:', error);
  process.exit(1);
});
