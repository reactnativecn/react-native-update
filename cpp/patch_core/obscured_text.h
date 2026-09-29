#ifndef PUSHY_PATCH_CORE_OBSCURED_TEXT_H_
#define PUSHY_PATCH_CORE_OBSCURED_TEXT_H_

#include <cstdlib>
#include <cstring>
#include <string>

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace text {

// Decodes text produced by scripts/encode-native-text.ts: byte i is XORed with
// (0x5A + 0x1D * i) & 0xFF. Keeps class names, method names and protocol
// strings out of static string scans of the binary; it is not a secret. The
// key base is read through a volatile so the optimizer cannot fold a constant
// argument back into a plain string.
inline std::string Reveal(const char* hex) {
  static volatile unsigned char key_base = 0x5A;
  const unsigned char base = key_base;
  const size_t length = std::strlen(hex) / 2;
  std::string out(length, '\0');
  for (size_t i = 0; i < length; ++i) {
    const char pair[3] = {hex[i * 2], hex[i * 2 + 1], 0};
    const unsigned char byte =
        static_cast<unsigned char>(std::strtoul(pair, nullptr, 16));
    out[i] = static_cast<char>(byte ^ static_cast<unsigned char>(base + 0x1D * i));
  }
  return out;
}

// Decodes once into storage that lives for the whole process, for constants
// that must stay valid as const char* (error codes and the like).
inline const char* RevealStatic(const char* hex) {
  return (new std::string(Reveal(hex)))->c_str();
}

}  // namespace text
}  // namespace pushy

#pragma GCC visibility pop

#endif  // PUSHY_PATCH_CORE_OBSCURED_TEXT_H_
