#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace pushy {
namespace digest {

// Streaming SHA-256 (FIPS 180-4). Used for bundleHash (the identity of the
// bundle embedded in the binary) and, later, download artifact verification
// (IO-6). Streaming because Android/Harmony read the bundle from the package
// (AssetManager / rawfile) rather than from a plain file.
//
// Android intentionally does NOT use this implementation: librnupdate.so is a
// prebuilt artifact, so the Java layer hashes with java.security.MessageDigest
// instead. The NIST vectors in the tests anchor both implementations to the
// same standard.
class Sha256 {
 public:
  Sha256();

  void Update(const uint8_t* data, size_t length);

  // Finalizes and returns the lowercase hex digest. The instance must not be
  // reused afterwards.
  std::string HexDigest();

 private:
  void ProcessBlock(const uint8_t* block);

  uint32_t state_[8];
  uint64_t total_length_ = 0;
  uint8_t buffer_[64];
  size_t buffer_length_ = 0;
};

// Hashes a file on disk (streaming, bounded memory). Returns the lowercase hex
// digest, or an empty string if the file cannot be read.
std::string Sha256File(const std::string& path);

// Streaming CRC32 (IEEE 802.3, reflected polynomial 0xEDB88320 — the zip /
// zlib checksum). Used to verify pdiff copy sources against the CRCs the CLI
// records from the origin package's zip entries (copiesCrc in __diff.json):
// the values must be byte-compatible with what any zip tool would report.
class Crc32 {
 public:
  void Update(const uint8_t* data, size_t length);

  uint32_t Value() const { return state_ ^ 0xFFFFFFFFu; }

 private:
  uint32_t state_ = 0xFFFFFFFFu;
};

// CRC32 of a file on disk (streaming, bounded memory). Returns false if the
// file cannot be read.
bool Crc32File(const std::string& path, uint32_t* out);

}  // namespace digest
}  // namespace pushy
