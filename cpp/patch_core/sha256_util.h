#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

extern "C" {
#include "Sha256.h"
}

namespace pushy {
namespace crypto {

class Sha256Hasher {
 public:
  Sha256Hasher();

  void Update(const void* data, size_t size);
  std::string FinalHex();

 private:
  CSha256 context_;
  bool finalized_ = false;
};

std::string Sha256Hex(const void* data, size_t size);

}  // namespace crypto
}  // namespace pushy
