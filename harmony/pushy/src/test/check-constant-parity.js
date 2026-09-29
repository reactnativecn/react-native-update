#!/usr/bin/env node
// Asserts that the ArkTS "hand-kept mirrors" of the shared C++ headers still
// carry the same values. Plain Node, no SDK: runs on every PR
// (.github/workflows/harmony-build.yml) so a limit or code bumped in
// cpp/patch_core cannot silently drift on Harmony.
//
//   cpp/patch_core/archive_limits.h  <-> harmony/.../ArchiveLimits.ts
//   cpp/patch_core/install_record.h  <-> harmony/.../InstallRecord.ts
//   cpp/patch_core/error_codes.h     <-> harmony/.../ErrorCodes.ts
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// `constexpr <type> kName = <expr>;` — the value is either a string literal or
// an integer expression built from literals, `*`, `+`, parentheses and the
// LL suffix.
function parseCppConstants(source) {
  const re =
    /(?:constexpr|inline)\s+(?:const\s+)?(?:long\s+long|int|char\s*\*)\s*(?:const\s+)?k([A-Za-z0-9]+)\s*=\s*([^;]+);/g;
  const values = new Map();
  let match;
  while ((match = re.exec(source)) !== null) {
    values.set(match[1], evaluate(match[2].trim(), match[1]));
  }
  return values;
}

// `export const NAME = <expr>;`
function parseArkTsConstants(source) {
  const re = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[a-z]+)?\s*=\s*([^;]+);/g;
  const values = new Map();
  let match;
  while ((match = re.exec(source)) !== null) {
    values.set(match[1], evaluate(match[2].trim(), match[1]));
  }
  return values;
}

// Encoded text (obscured_text.h / Texts.ts, scripts/encode-native-text.ts):
// byte i XORed with (0x5A + 0x1D * i) & 0xFF.
function reveal(hex) {
  let text = '';
  for (let i = 0; i < hex.length / 2; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    text += String.fromCharCode(byte ^ ((0x5a + 0x1d * i) & 0xff));
  }
  return text;
}

function evaluate(expression, name) {
  const text = expression.replace(/\s+/g, ' ').trim();
  const encoded = text.match(/^(?:text::RevealStatic|revealText)\((["'])([0-9a-f]+)\1\)$/);
  if (encoded) {
    return reveal(encoded[2]);
  }
  const stringLiteral = text.match(/^(["'])((?:\\.|(?!\1).)*)\1$/);
  if (stringLiteral) {
    return stringLiteral[2];
  }
  const numeric = text.replace(/(\d)LL\b/g, '$1');
  if (!/^[\d\s()*+]+$/.test(numeric)) {
    throw new Error(`check-constant-parity: cannot evaluate ${name} = ${text}`);
  }
  // Only digits and arithmetic operators survive the regex above.
  return Function(`"use strict"; return (${numeric});`)();
}

// kMaxArchiveBytes -> MAX_ARCHIVE_BYTES
function screamingSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

const pairs = [
  {
    header: 'cpp/patch_core/archive_limits.h',
    mirror: 'harmony/pushy/src/main/ets/ArchiveLimits.ts',
    mirrorName: (cppName) => screamingSnake(cppName),
  },
  {
    header: 'cpp/patch_core/install_record.h',
    mirror: 'harmony/pushy/src/main/ets/InstallRecord.ts',
    mirrorName: (cppName) =>
      ({
        Schema: 'INSTALL_RECORD_SCHEMA',
        FileName: 'INSTALL_RECORD_FILE_NAME',
        StagingSuffix: 'STAGING_SUFFIX',
      })[cppName] || screamingSnake(cppName),
  },
  {
    header: 'cpp/patch_core/error_codes.h',
    mirror: 'harmony/pushy/src/main/ets/ErrorCodes.ts',
    mirrorName: (cppName) => `ERROR_${screamingSnake(cppName)}`,
    // Every ERROR_* export must exist in the header too (no invented codes).
    mirrorPrefix: 'ERROR_',
  },
];

const problems = [];
let checked = 0;

for (const pair of pairs) {
  const cpp = parseCppConstants(read(pair.header));
  const arkts = parseArkTsConstants(read(pair.mirror));
  if (cpp.size === 0) {
    problems.push(`${pair.header}: no constexpr constants parsed`);
    continue;
  }
  for (const [cppName, cppValue] of cpp) {
    const mirrorName = pair.mirrorName(cppName);
    checked += 1;
    if (!arkts.has(mirrorName)) {
      problems.push(
        `${pair.mirror}: missing ${mirrorName} (k${cppName} in ${pair.header})`
      );
      continue;
    }
    const mirrorValue = arkts.get(mirrorName);
    if (mirrorValue !== cppValue) {
      problems.push(
        `${pair.mirror}: ${mirrorName} = ${JSON.stringify(mirrorValue)} but ` +
          `${pair.header} k${cppName} = ${JSON.stringify(cppValue)}`
      );
    }
  }
  if (pair.mirrorPrefix) {
    const known = new Set(Array.from(cpp.keys()).map(pair.mirrorName));
    for (const name of arkts.keys()) {
      if (name.startsWith(pair.mirrorPrefix) && !known.has(name)) {
        problems.push(`${pair.mirror}: ${name} has no counterpart in ${pair.header}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check-constant-parity: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(
  `check-constant-parity: ${checked} constants match across ${pairs.length} header/mirror pairs`
);
