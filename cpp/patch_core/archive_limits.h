#ifndef PUSHY_PATCH_CORE_ARCHIVE_LIMITS_H_
#define PUSHY_PATCH_CORE_ARCHIVE_LIMITS_H_

// Single source of truth for the resource caps applied to an update package
// before and while it is unpacked. A corrupt or hostile archive must be able
// to cost at most a bounded amount of disk, memory and time — never a full
// disk or a zip bomb. The caps are generous for real packages (a large full
// bundle with assets is tens of MB) and exist purely as damage bounds.
//
// Mirrors that cannot include this header MUST stay in sync by hand:
//   - android/.../ArchiveLimits.java
//   - harmony/pushy/src/main/ets/ArchiveLimits.ts
// iOS (RCTPushy.mm) includes this header directly.

namespace pushy {
namespace archive_limits {

// Downloaded archive (Content-Length up front, streamed bytes as backstop).
constexpr long long kMaxArchiveBytes = 512LL * 1024 * 1024;
// Sum of every entry's uncompressed size.
constexpr long long kMaxTotalUncompressedBytes = 2048LL * 1024 * 1024;
// A single entry's uncompressed size.
constexpr long long kMaxEntryBytes = 512LL * 1024 * 1024;
// Number of entries in one archive.
constexpr long long kMaxEntries = 20000;
// Per-entry uncompressed/compressed ratio, checked only above
// kRatioCheckMinBytes (tiny highly-compressible files are legitimate).
constexpr long long kMaxCompressionRatio = 100;
constexpr long long kRatioCheckMinBytes = 1LL * 1024 * 1024;
// __diff.json is parsed fully in memory.
constexpr long long kMaxManifestBytes = 16LL * 1024 * 1024;
// Free disk required beyond the bytes about to be written.
constexpr long long kFreeDiskMarginBytes = 64LL * 1024 * 1024;
// A download whose length is unknown up front (chunked / encoded body) can
// only reserve the margin when the response arrives; the disk is re-probed
// before the first body byte and then every this many streamed bytes, each
// probe reserving this many bytes ahead, so the writes between two probes
// can never eat into the margin.
constexpr long long kUnknownLengthFreeSpaceProbeBytes = 8LL * 1024 * 1024;

}  // namespace archive_limits
}  // namespace pushy

#endif  // PUSHY_PATCH_CORE_ARCHIVE_LIMITS_H_
