#!/usr/bin/env node
// The release tag (vX.Y.Z) must be the package.json version being published:
// a mismatch means the tag points at the wrong commit or the version bump
// was forgotten, and npm would happily publish under the stale number.
const pkg = require('../package.json');
const tag = process.env.RELEASE_VERSION || '';
if (!tag) {
  console.error('check-release-version: RELEASE_VERSION is not set');
  process.exit(1);
}
const expected = `v${pkg.version}`;
if (tag !== expected && tag !== pkg.version) {
  console.error(
    `check-release-version: tag ${tag} does not match package.json version ${pkg.version}`
  );
  process.exit(1);
}

// The Harmony HAR carries its own version (oh-package.json5); consumers'
// oh-package-lock.json5 and diagnostics can only tell installs apart when it
// tracks package.json. scripts/build-harmony-har.js rewrites it before
// assembleHar, and this check keeps the committed value from drifting.
const fs = require('fs');
const path = require('path');
const ohPackagePath = path.join(__dirname, '..', 'harmony/pushy/oh-package.json5');
const ohPackage = fs.readFileSync(ohPackagePath, 'utf8');
// JSON5 allows the key bare or quoted; the regex is shared in spirit with
// syncOhPackageVersion in scripts/build-harmony-har.js.
const ohVersion = (ohPackage.match(
  /^\s*(?:"version"|'version'|version)\s*:\s*['"]([^'"]+)['"]/m
) || [])[1];
if (ohVersion !== pkg.version) {
  console.error(
    `check-release-version: harmony/pushy/oh-package.json5 version ${ohVersion} does not match package.json version ${pkg.version}`
  );
  process.exit(1);
}
console.log(
  `check-release-version: ${tag} matches package.json and oh-package.json5 ${pkg.version}`
);
