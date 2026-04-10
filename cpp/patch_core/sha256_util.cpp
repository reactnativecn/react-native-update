#include "sha256_util.h"

namespace pushy {
namespace crypto {

namespace {

std::string ToHexString(const Byte* digest, size_t size) {
  static constexpr char kHexDigits[] = "0123456789abcdef";
  std::string hex(size * 2, '\0');
  for (size_t index = 0; index < size; ++index) {
    const unsigned char byte = digest[index];
    hex[index * 2] = kHexDigits[byte >> 4];
    hex[index * 2 + 1] = kHexDigits[byte & 0x0f];
  }
  return hex;
}

}  // namespace

Sha256Hasher::Sha256Hasher() {
  Sha256_Init(&context_);
}

void Sha256Hasher::Update(const void* data, size_t size) {
  if (finalized_ || data == nullptr || size == 0) {
    return;
  }
  Sha256_Update(
      &context_,
      static_cast<const Byte*>(data),
      size);
}

std::string Sha256Hasher::FinalHex() {
  Byte digest[SHA256_DIGEST_SIZE] = {0};
  Sha256_Final(&context_, digest);
  finalized_ = true;
  return ToHexString(digest, SHA256_DIGEST_SIZE);
}

std::string Sha256Hex(const void* data, size_t size) {
  Sha256Hasher hasher;
  hasher.Update(data, size);
  return hasher.FinalHex();
}

}  // namespace crypto
}  // namespace pushy
