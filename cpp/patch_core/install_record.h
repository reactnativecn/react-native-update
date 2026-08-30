#ifndef PUSHY_PATCH_CORE_INSTALL_RECORD_H_
#define PUSHY_PATCH_CORE_INSTALL_RECORD_H_

// The completion record every platform writes into a version directory once
// an install fully succeeded, and reads back before trusting that directory.
//
//   <root>/<hash>/.pushy-complete
//   {"schema":1,"versionHash":"<hash>","bundleSha256":"<hex>","artifactSha256":"<hex>"}
//
// - Written by the SDK only (archives may not ship a `.pushy-*` entry), as
//   the LAST step of a two-phase install: unpack/patch into
//   <root>/<hash>.staging, write the record there, then atomically rename
//   the staging directory to <root>/<hash>.
// - versionHash must equal the directory name; bundleSha256 is the digest of
//   the final index.bundlejs (bundle.harmony.js on Harmony) and is
//   re-verified at switchVersion time; artifactSha256 is the digest of the
//   downloaded archive (diagnostics / CDN corruption attribution).
// - Legacy: an EMPTY file is a completed install written by SDK < 10.53
//   (no digests); it stays trusted for presence, nothing to verify.
//
// Mirrors that cannot include this header MUST stay in sync by hand:
//   - android/.../InstallRecord.java
//   - harmony/pushy/src/main/ets/InstallRecord.ts
// iOS (RCTPushy.mm) includes this header directly.

namespace pushy {
namespace install_record {

constexpr int kSchema = 1;
constexpr const char* kFileName = ".pushy-complete";
constexpr const char* kStagingSuffix = ".staging";

}  // namespace install_record
}  // namespace pushy

#endif  // PUSHY_PATCH_CORE_INSTALL_RECORD_H_
