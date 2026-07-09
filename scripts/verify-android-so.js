#!/usr/bin/env node
/**
 * Verify the prebuilt Android native libraries shipped in android/lib/ are
 * present for every ABI and export the JNI symbols the Java layer binds. This
 * guards against publishing an npm package whose committed librnupdate.so is
 * stale/missing after a cpp/patch_core change (which would crash consumers at
 * runtime with UnsatisfiedLinkError while CI stays green).
 *
 * Reads the ELF .dynsym table directly so it needs no external tools — the
 * previous llvm-nm/nm based check failed on CI runners (e.g. the HarmonyOS
 * docker image) that ship no binutils.
 *
 * Usage: node scripts/verify-android-so.js
 */
const fs = require('fs');
const path = require('path');

const LIB_DIR = path.resolve(__dirname, '..', 'android', 'lib');
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];

// ELF e_machine per ABI, so a symbol-complete .so placed in the wrong ABI
// directory (mixed-up artifacts) still fails verification.
const ABI_MACHINE = {
  'arm64-v8a': 0xb7, // EM_AARCH64
  'armeabi-v7a': 0x28, // EM_ARM
  x86: 0x03, // EM_386
  x86_64: 0x3e, // EM_X86_64
};

// JNI entry points the Java `native` declarations bind to. Keep in sync with
// the native methods in android/src/main/java/cn/reactnative/modules/update/.
const REQUIRED_SYMBOLS = [
  'Java_cn_reactnative_modules_update_DownloadTask_applyPatchFromFileSource',
  'Java_cn_reactnative_modules_update_DownloadTask_cleanupOldEntries',
  'Java_cn_reactnative_modules_update_DownloadTask_buildArchivePatchPlan',
  'Java_cn_reactnative_modules_update_DownloadTask_buildCopyGroups',
  'Java_cn_reactnative_modules_update_UpdateContext_syncStateWithBinaryVersion',
  'Java_cn_reactnative_modules_update_UpdateContext_runStateCore',
  'Java_cn_reactnative_modules_update_NativeUpdateCore_getSupportedDiffVersion',
];

const SHT_DYNSYM = 11;
const SHN_UNDEF = 0;
const PT_LOAD = 1;

// Google Play requires 16 KB page-size support for 64-bit ABIs: every ELF
// LOAD segment must be aligned to at least 16384 bytes. v10.45.0–v10.48.0
// shipped 4 KB-aligned libraries because the publish CI resolved an old NDK,
// and nothing caught it — this check makes that failure loud.
const PAGE_ALIGN_ABIS = { 'arm64-v8a': 16384, x86_64: 16384 };

/** Returns the smallest p_align among the ELF's LOAD segments. */
function readMinLoadAlignment(buffer) {
  const is64 = buffer[4] === 2;
  const phoff = is64
    ? Number(buffer.readBigUInt64LE(0x20))
    : buffer.readUInt32LE(0x1c);
  const phentsize = buffer.readUInt16LE(is64 ? 0x36 : 0x2a);
  const phnum = buffer.readUInt16LE(is64 ? 0x38 : 0x2c);

  let min = Infinity;
  for (let i = 0; i < phnum; i++) {
    const base = phoff + i * phentsize;
    if (buffer.readUInt32LE(base) !== PT_LOAD) {
      continue;
    }
    const align = is64
      ? Number(buffer.readBigUInt64LE(base + 0x30))
      : buffer.readUInt32LE(base + 0x1c);
    min = Math.min(min, align);
  }
  if (min === Infinity) {
    throw new Error('no LOAD segments');
  }
  return min;
}

/** Returns the set of defined dynamic symbol names exported by an ELF file. */
function readDynamicSymbols(buffer, expectedMachine) {
  if (
    buffer.length < 64 ||
    buffer[0] !== 0x7f ||
    buffer.toString('ascii', 1, 4) !== 'ELF'
  ) {
    throw new Error('not an ELF file');
  }
  const is64 = buffer[4] === 2;
  if (buffer[5] !== 1) {
    // ei_data: all Android ABIs are little-endian.
    throw new Error('unsupported ELF endianness');
  }
  const machine = buffer.readUInt16LE(0x12);
  if (expectedMachine !== undefined && machine !== expectedMachine) {
    throw new Error(
      `wrong architecture: e_machine 0x${machine.toString(16)} (expected 0x${expectedMachine.toString(16)})`,
    );
  }

  const shoff = is64
    ? Number(buffer.readBigUInt64LE(0x28))
    : buffer.readUInt32LE(0x20);
  const shentsize = buffer.readUInt16LE(is64 ? 0x3a : 0x2e);
  const shnum = buffer.readUInt16LE(is64 ? 0x3c : 0x30);

  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const base = shoff + i * shentsize;
    sections.push(
      is64
        ? {
            type: buffer.readUInt32LE(base + 4),
            offset: Number(buffer.readBigUInt64LE(base + 24)),
            size: Number(buffer.readBigUInt64LE(base + 32)),
            link: buffer.readUInt32LE(base + 40),
            entsize: Number(buffer.readBigUInt64LE(base + 56)),
          }
        : {
            type: buffer.readUInt32LE(base + 4),
            offset: buffer.readUInt32LE(base + 16),
            size: buffer.readUInt32LE(base + 20),
            link: buffer.readUInt32LE(base + 24),
            entsize: buffer.readUInt32LE(base + 36),
          },
    );
  }

  const dynsym = sections.find(section => section.type === SHT_DYNSYM);
  if (!dynsym) {
    throw new Error('no .dynsym section (fully stripped?)');
  }
  const dynstr = sections[dynsym.link];
  if (!dynstr) {
    throw new Error('missing .dynstr section');
  }

  const readName = nameOffset => {
    const start = dynstr.offset + nameOffset;
    const end = buffer.indexOf(0, start);
    return buffer.toString('utf8', start, end);
  };

  const symbols = new Set();
  const entsize = dynsym.entsize || (is64 ? 24 : 16);
  for (let offset = 0; offset + entsize <= dynsym.size; offset += entsize) {
    const base = dynsym.offset + offset;
    const nameOffset = buffer.readUInt32LE(base);
    const shndx = buffer.readUInt16LE(base + (is64 ? 6 : 14));
    if (nameOffset !== 0 && shndx !== SHN_UNDEF) {
      symbols.add(readName(nameOffset));
    }
  }
  return symbols;
}

let failed = false;
for (const abi of ABIS) {
  const soPath = path.join(LIB_DIR, abi, 'librnupdate.so');
  let stat;
  try {
    stat = fs.statSync(soPath);
  } catch {
    console.error(`error: missing native library: ${soPath}`);
    failed = true;
    continue;
  }
  if (stat.size === 0) {
    console.error(`error: empty native library: ${soPath}`);
    failed = true;
    continue;
  }

  const buffer = fs.readFileSync(soPath);
  let symbols;
  try {
    symbols = readDynamicSymbols(buffer, ABI_MACHINE[abi]);
  } catch (error) {
    console.error(`error: cannot read symbols from ${soPath}: ${error.message}`);
    failed = true;
    continue;
  }

  const requiredAlign = PAGE_ALIGN_ABIS[abi];
  if (requiredAlign) {
    try {
      const align = readMinLoadAlignment(buffer);
      if (align < requiredAlign) {
        console.error(
          `error: ${soPath} LOAD segments aligned to ${align} bytes; Google Play ` +
            `requires ${requiredAlign} (16 KB page size) for ${abi}. Rebuild with ` +
            `NDK r28+ ('npm run build:so').`,
        );
        failed = true;
      }
    } catch (error) {
      console.error(
        `error: cannot read LOAD alignment from ${soPath}: ${error.message}`,
      );
      failed = true;
    }
  }

  const missing = REQUIRED_SYMBOLS.filter(symbol => !symbols.has(symbol));
  if (missing.length) {
    for (const symbol of missing) {
      console.error(
        `error: ${soPath} does not export ${symbol} (stale .so? rebuild with 'npm run build:so')`,
      );
    }
    failed = true;
  } else {
    console.log(`ok: ${abi} librnupdate.so exports all required symbols`);
  }
}

if (failed) {
  console.error('Android native library verification FAILED.');
  process.exit(1);
}
console.log('All Android native libraries verified.');
