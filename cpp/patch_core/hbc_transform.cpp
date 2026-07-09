#include "hbc_transform.h"

#include <cstring>

namespace pushy {
namespace hbc {

namespace {

constexpr uint8_t kHbcMagic[8] =
    {0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f};
constexpr size_t kHeaderSize = 128;
constexpr size_t kCountsOffset = 32; // magic(8) + version(4) + sourceHash(20)
constexpr uint32_t kMaxEntryCount = 0x0fffffff;
constexpr uint32_t kMaxEntrySize = 4096;
constexpr uint32_t kMaxSections = 64;
constexpr uint32_t kMaxCountFields = (kHeaderSize - kCountsOffset) / 4; // 24

inline uint32_t ReadU32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
      (static_cast<uint32_t>(p[2]) << 16) |
      (static_cast<uint32_t>(p[3]) << 24);
}

inline void WriteU32(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v);
  p[1] = static_cast<uint8_t>(v >> 8);
  p[2] = static_cast<uint8_t>(v >> 16);
  p[3] = static_cast<uint8_t>(v >> 24);
}

inline uint64_t Align4(uint64_t x) {
  return (x + 3) & ~static_cast<uint64_t>(3);
}

struct ResolvedSection {
  uint64_t start;
  uint64_t size;
  const HbcSectionDesc* desc;
};

} // namespace

bool TransformHbcInPlace(
    uint8_t* data,
    size_t size,
    const HbcLayoutDesc& layout,
    bool inverse) {
  // ---- 校验阶段:改写任何字节之前完成全部检查 ----
  if (data == nullptr || size < kHeaderSize) {
    return false;
  }
  if (std::memcmp(data, kHbcMagic, sizeof(kHbcMagic)) != 0) {
    return false;
  }
  if (layout.headerCountFields < 2 ||
      layout.headerCountFields > kMaxCountFields) {
    return false;
  }
  if (layout.sections == nullptr || layout.sectionCount == 0 ||
      layout.sectionCount > kMaxSections) {
    return false;
  }

  uint32_t counts[kMaxCountFields];
  for (uint32_t i = 0; i < layout.headerCountFields; ++i) {
    counts[i] = ReadU32(data + kCountsOffset + static_cast<size_t>(i) * 4);
  }
  // 位置约定:槽位 0 = fileLength,最后一个槽位 = debugInfoOffset
  const uint64_t fileLength = counts[0];
  const uint64_t debugInfoOffset = counts[layout.headerCountFields - 1];
  if (fileLength != size) {
    return false;
  }
  if (debugInfoOffset < kHeaderSize || debugInfoOffset > size) {
    return false;
  }

  ResolvedSection resolved[kMaxSections];
  uint64_t off = kHeaderSize;
  for (uint32_t i = 0; i < layout.sectionCount; ++i) {
    const HbcSectionDesc& s = layout.sections[i];
    if (s.countIndex >= layout.headerCountFields) {
      return false;
    }
    if (s.entrySize == 0 || s.entrySize > kMaxEntrySize) {
      return false;
    }
    const uint64_t count = counts[s.countIndex];
    if (count > kMaxEntryCount) {
      return false;
    }
    if (s.deltaFieldCount > 0 && s.deltaFields == nullptr) {
      return false;
    }
    for (uint32_t f = 0; f < s.deltaFieldCount; ++f) {
      const HbcDeltaField& field = s.deltaFields[f];
      // bit 必须单独设上界:bit=0xFFFFFFFF 时 bit+bits 的 uint32 求和会回绕
      // 绕过 >32 检查,改写阶段的 << bit 就成了移位量 ≥32 的 UB。
      // bits≥1 时合法 bit 必 ≤31。
      if (field.bits < 1 || field.bits > 32 || field.bit > 31 ||
          field.bit + field.bits > 32 ||
          static_cast<uint64_t>(field.byte) + 4 > s.entrySize) {
        return false;
      }
    }
    const uint64_t sectionSize = count * s.entrySize; // ≤ 2^28 × 2^12 < 2^40
    off = Align4(off);
    if (off + sectionSize > debugInfoOffset) {
      return false;
    }
    resolved[i] = {off, sectionSize, &s};
    off += sectionSize;
  }

  // ---- 改写阶段:校验通过后不再有失败路径 ----
  for (uint32_t i = 0; i < layout.sectionCount; ++i) {
    const ResolvedSection& r = resolved[i];
    const HbcSectionDesc& s = *r.desc;
    for (uint32_t f = 0; f < s.deltaFieldCount; ++f) {
      const HbcDeltaField& field = s.deltaFields[f];
      const uint32_t fieldMask =
          field.bits == 32 ? 0xffffffffu : ((1u << field.bits) - 1u);
      const uint32_t mask = fieldMask << field.bit;
      uint32_t prev = 0;
      const uint64_t end = r.start + r.size;
      for (uint64_t p = r.start + field.byte; p < end; p += s.entrySize) {
        uint8_t* wordPtr = data + p;
        const uint32_t word = ReadU32(wordPtr);
        const uint32_t val = (word >> field.bit) & fieldMask;
        uint32_t enc;
        if (!inverse) {
          enc = (val - prev) & fieldMask;
          prev = val;
        } else {
          enc = (val + prev) & fieldMask;
          prev = enc;
        }
        WriteU32(wordPtr, (word & ~mask) | (enc << field.bit));
      }
    }
  }
  return true;
}

} // namespace hbc
} // namespace pushy
