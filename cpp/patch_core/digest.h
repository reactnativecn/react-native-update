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

}  // namespace digest
}  // namespace pushy
