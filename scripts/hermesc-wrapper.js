#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// Allow overriding the real hermesc path (e.g. for Pods/monorepo layouts where
// react-native is not directly under PROJECT_ROOT/node_modules).
const realHermescPath =
  process.env.RNUPDATE_REAL_HERMESC ||
  path.join(PROJECT_ROOT, 'node_modules/react-native/sdks/hermesc/osx-bin/_hermesc');
const args = process.argv.slice(2);

console.log(`[Hermesc Wrapper] Executing Hermes compilation...`);
console.log(`[Hermesc Wrapper] Args:`, args.join(' '));

const isCompileOperation = args.includes('-emit-binary');
let outputFile = null;

const outIndex = args.indexOf('-out');
if (outIndex !== -1 && outIndex + 1 < args.length) {
  outputFile = args[outIndex + 1];
}

const hermesc = spawn(realHermescPath, args, {
  stdio: 'inherit',
  env: process.env
});

hermesc.on('error', (error) => {
  console.error(`[Hermesc Wrapper] ❌ Failed to start hermesc:`, error);
  process.exit(1);
});

hermesc.on('close', (code, signal) => {
  console.log(`[Hermesc Wrapper] Hermes compilation completed with code: ${code}, signal: ${signal}`);

  // A null exit code means hermesc was terminated by a signal — treat that as a
  // failure rather than success.
  if (code !== 0 || signal) {
    process.exit(code == null ? 1 : code);
    return;
  }

  if (isCompileOperation && outputFile) {
    console.log(`[Hermesc Wrapper] 🔄 Post-processing HBC file: ${outputFile}`);
    // The output file is fully written by the time `close` fires, so process
    // it synchronously instead of racing on a fixed timer.
    processHBCFile(outputFile);
  } else {
    process.exit(0);
  }
});

function processHBCFile(hbcFilePath) {
  const hashFilePath = path.join(PROJECT_ROOT, 'bundle-hash.json');

  if (!fs.existsSync(hashFilePath)) {
    console.warn(`[Hermesc Wrapper] ⚠️  Hash file not found: ${hashFilePath}`);
    console.warn(`[Hermesc Wrapper] Skipping metadata injection.`);
    process.exit(0);
    return;
  }

  if (!fs.existsSync(hbcFilePath)) {
    console.warn(`[Hermesc Wrapper] ⚠️  HBC file not found: ${hbcFilePath}`);
    console.warn(`[Hermesc Wrapper] Skipping metadata injection.`);
    process.exit(0);
    return;
  }

  try {
    const hashData = JSON.parse(fs.readFileSync(hashFilePath, 'utf8'));
    const { contentHash } = hashData;

    console.log(`[Hermesc Wrapper] 📝 Injecting metadata into HBC...`);
    console.log(`[Hermesc Wrapper] Hash: ${contentHash.slice(0, 16)}...`);

    const hbcBuffer = fs.readFileSync(hbcFilePath);

    const metadata = { contentHash };
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

    fs.writeFileSync(hbcFilePath, finalBuffer);

    console.log(`[Hermesc Wrapper] ✅ Successfully injected metadata into: ${hbcFilePath}`);
    console.log(`[Hermesc Wrapper] 🧹 Cleaning up hash file...`);

    // Actually remove the hash file so a stale contentHash is not reused by a
    // subsequent build that fails to regenerate it.
    try {
      fs.unlinkSync(hashFilePath);
    } catch (cleanupError) {
      console.warn(`[Hermesc Wrapper] ⚠️  Failed to remove hash file:`, cleanupError);
    }

    process.exit(0);
  } catch (error) {
    console.error(`[Hermesc Wrapper] ❌ Failed to process HBC file:`, error);
    process.exit(1);
  }
}
