#include "digest.h"

#include <cstdio>
#include <cstring>

namespace pushy {
namespace digest {

namespace {

// FIPS 180-4 SHA-256 round constants.
constexpr uint32_t kRoundConstants[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

inline uint32_t RotateRight(uint32_t value, uint32_t bits) {
  return (value >> bits) | (value << (32 - bits));
}

}  // namespace

Sha256::Sha256() {
  state_[0] = 0x6a09e667;
  state_[1] = 0xbb67ae85;
  state_[2] = 0x3c6ef372;
  state_[3] = 0xa54ff53a;
  state_[4] = 0x510e527f;
  state_[5] = 0x9b05688c;
  state_[6] = 0x1f83d9ab;
  state_[7] = 0x5be0cd19;
}

void Sha256::ProcessBlock(const uint8_t* block) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) |
           (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
           (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
           static_cast<uint32_t>(block[i * 4 + 3]);
  }
  for (int i = 16; i < 64; i++) {
    const uint32_t s0 = RotateRight(w[i - 15], 7) ^ RotateRight(w[i - 15], 18) ^
                        (w[i - 15] >> 3);
    const uint32_t s1 = RotateRight(w[i - 2], 17) ^ RotateRight(w[i - 2], 19) ^
                        (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }

  uint32_t a = state_[0];
  uint32_t b = state_[1];
  uint32_t c = state_[2];
  uint32_t d = state_[3];
  uint32_t e = state_[4];
  uint32_t f = state_[5];
  uint32_t g = state_[6];
  uint32_t h = state_[7];

  for (int i = 0; i < 64; i++) {
    const uint32_t s1 =
        RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
    const uint32_t ch = (e & f) ^ (~e & g);
    const uint32_t temp1 = h + s1 + ch + kRoundConstants[i] + w[i];
    const uint32_t s0 =
        RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = s0 + maj;

    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  state_[0] += a;
  state_[1] += b;
  state_[2] += c;
  state_[3] += d;
  state_[4] += e;
  state_[5] += f;
  state_[6] += g;
  state_[7] += h;
}

void Sha256::Update(const uint8_t* data, size_t length) {
  total_length_ += length;

  if (buffer_length_ > 0) {
    const size_t fill = 64 - buffer_length_;
    const size_t take = length < fill ? length : fill;
    std::memcpy(buffer_ + buffer_length_, data, take);
    buffer_length_ += take;
    data += take;
    length -= take;
    if (buffer_length_ < 64) {
      return;
    }
    ProcessBlock(buffer_);
    buffer_length_ = 0;
  }

  while (length >= 64) {
    ProcessBlock(data);
    data += 64;
    length -= 64;
  }

  if (length > 0) {
    std::memcpy(buffer_, data, length);
    buffer_length_ = length;
  }
}

std::string Sha256::HexDigest() {
  // Padding: 0x80, zeros, then the 64-bit big-endian bit length.
  const uint64_t bit_length = total_length_ * 8;
  const uint8_t pad_byte = 0x80;
  Update(&pad_byte, 1);
  const uint8_t zero = 0x00;
  // total_length_ is mutated by the padding updates; the final length field is
  // captured above, so this loop only needs to reach the 56-byte boundary.
  while (buffer_length_ != 56) {
    Update(&zero, 1);
  }
  uint8_t length_bytes[8];
  for (int i = 0; i < 8; i++) {
    length_bytes[i] = static_cast<uint8_t>(bit_length >> (56 - i * 8));
  }
  Update(length_bytes, 8);

  static const char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (int i = 0; i < 8; i++) {
    for (int shift = 24; shift >= 0; shift -= 8) {
      const uint8_t byte = static_cast<uint8_t>(state_[i] >> shift);
      out.push_back(kHex[byte >> 4]);
      out.push_back(kHex[byte & 0x0f]);
    }
  }
  return out;
}

std::string Sha256File(const std::string& path) {
  std::FILE* file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    return std::string();
  }
  Sha256 hasher;
  uint8_t buffer[64 * 1024];
  size_t read = 0;
  while ((read = std::fread(buffer, 1, sizeof(buffer), file)) > 0) {
    hasher.Update(buffer, read);
  }
  const bool failed = std::ferror(file) != 0;
  std::fclose(file);
  if (failed) {
    return std::string();
  }
  return hasher.HexDigest();
}

}  // namespace digest
}  // namespace pushy
