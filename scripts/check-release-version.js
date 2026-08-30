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
console.log(
  `check-release-version: ${tag} matches package.json ${pkg.version}`
);
