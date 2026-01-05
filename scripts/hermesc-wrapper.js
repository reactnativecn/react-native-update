#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const realHermescPath = path.join(PROJECT_ROOT, 'node_modules/react-native/sdks/hermesc/osx-bin/_hermesc');
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

hermesc.on('close', (code) => {
  console.log(`[Hermesc Wrapper] Hermes compilation completed with code: ${code}`);

  if (code === 0 && isCompileOperation && outputFile) {
    console.log(`[Hermesc Wrapper] 🔄 Post-processing HBC file: ${outputFile}`);

    setTimeout(() => {
      processHBCFile(outputFile);
    }, 500);
  } else {
    process.exit(code);
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

    process.exit(0);
  } catch (error) {
    console.error(`[Hermesc Wrapper] ❌ Failed to process HBC file:`, error);
    process.exit(1);
  }
}
