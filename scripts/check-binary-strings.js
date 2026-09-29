#!/usr/bin/env node
// Fails when a shipped native binary carries update/patch/rescue/reload wording
// in its string table (the `strings` view of the file): class and method names,
// log text, source paths and the like are kept neutral or encoded
// (scripts/encode-native-text.ts). Usage:
//   node scripts/check-binary-strings.js <binary>...
'use strict';

const fs = require('fs');

const WORDING = /update|patch|rescue|reload|hotfix/i;
const MIN_LENGTH = 4;

function printableRuns(buffer) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= buffer.length; i++) {
    const byte = i < buffer.length ? buffer[i] : 0;
    const printable = byte >= 0x20 && byte < 0x7f;
    if (printable && start < 0) {
      start = i;
    } else if (!printable && start >= 0) {
      if (i - start >= MIN_LENGTH) {
        runs.push(buffer.toString('latin1', start, i));
      }
      start = -1;
    }
  }
  return runs;
}

function findWording(file) {
  return printableRuns(fs.readFileSync(file)).filter((run) => WORDING.test(run));
}

module.exports = { findWording };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: check-binary-strings.js <binary>...');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const hits = findWording(file);
    if (hits.length) {
      failed = true;
      for (const hit of hits) {
        console.error(`error: ${file} contains ${JSON.stringify(hit)}`);
      }
    } else {
      console.log(`ok: ${file} has no update wording in its strings`);
    }
  }
  process.exit(failed ? 1 : 0);
}
