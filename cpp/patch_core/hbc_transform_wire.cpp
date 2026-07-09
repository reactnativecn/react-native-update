#include "hbc_transform_wire.h"

namespace pushy {
namespace hbc {

namespace {

// 面向单一受限格式的手写递归下降解析器。不追求通用 JSON 兼容,
// 追求:无第三方依赖、输入不可信下的确定性行为、显式上限。
constexpr size_t kMaxInputBytes = 64 * 1024;
constexpr int kMaxDepth = 8;
constexpr uint32_t kMaxSections = 64;
constexpr uint32_t kMaxDeltaFields = 8;

struct Cursor {
  const char* p;
  const char* end;
};

void SkipWs(Cursor* c) {
  while (c->p < c->end &&
         (*c->p == ' ' || *c->p == '\t' || *c->p == '\n' || *c->p == '\r')) {
    ++c->p;
  }
}

bool Consume(Cursor* c, char ch) {
  SkipWs(c);
  if (c->p < c->end && *c->p == ch) {
    ++c->p;
    return true;
  }
  return false;
}

bool Peek(Cursor* c, char ch) {
  SkipWs(c);
  return c->p < c->end && *c->p == ch;
}

// 仅接受非负整数(本格式中所有数值都是非负整数)
bool ParseUInt(Cursor* c, uint32_t* out) {
  SkipWs(c);
  if (c->p >= c->end || *c->p < '0' || *c->p > '9') {
    return false;
  }
  uint64_t value = 0;
  while (c->p < c->end && *c->p >= '0' && *c->p <= '9') {
    value = value * 10 + static_cast<uint64_t>(*c->p - '0');
    if (value > 0xffffffffull) {
      return false;
    }
    ++c->p;
  }
  *out = static_cast<uint32_t>(value);
  return true;
}

bool ParseKey(Cursor* c, std::string* out) {
  SkipWs(c);
  if (!Consume(c, '"')) {
    return false;
  }
  out->clear();
  while (c->p < c->end && *c->p != '"') {
    if (*c->p == '\\') {
      return false; // 本格式的键不含转义
    }
    out->push_back(*c->p);
    ++c->p;
    if (out->size() > 64) {
      return false;
    }
  }
  return Consume(c, '"');
}

// 跳过未知键的值(数字/字符串/数组/对象),深度受限
bool SkipValue(Cursor* c, int depth) {
  if (depth > kMaxDepth) {
    return false;
  }
  SkipWs(c);
  if (c->p >= c->end) {
    return false;
  }
  const char ch = *c->p;
  if (ch == '"') {
    ++c->p;
    while (c->p < c->end && *c->p != '"') {
      if (*c->p == '\\') {
        ++c->p;
      }
      ++c->p;
    }
    return Consume(c, '"');
  }
  if (ch == '[' || ch == '{') {
    const char close = ch == '[' ? ']' : '}';
    ++c->p;
    SkipWs(c);
    if (Consume(c, close)) {
      return true;
    }
    while (true) {
      if (close == '}') {
        std::string key;
        if (!ParseKey(c, &key) || !Consume(c, ':')) {
          return false;
        }
      }
      if (!SkipValue(c, depth + 1)) {
        return false;
      }
      if (Consume(c, close)) {
        return true;
      }
      if (!Consume(c, ',')) {
        return false;
      }
    }
  }
  if ((ch >= '0' && ch <= '9') || ch == '-') {
    ++c->p;
    while (c->p < c->end &&
           ((*c->p >= '0' && *c->p <= '9') || *c->p == '.' || *c->p == 'e' ||
            *c->p == 'E' || *c->p == '+' || *c->p == '-')) {
      ++c->p;
    }
    return true;
  }
  // true/false/null
  for (const char* lit : {"true", "false", "null"}) {
    const size_t n = std::char_traits<char>::length(lit);
    if (static_cast<size_t>(c->end - c->p) >= n &&
        std::char_traits<char>::compare(c->p, lit, n) == 0) {
      c->p += n;
      return true;
    }
  }
  return false;
}

// [byte, bit, bits]
bool ParseDeltaField(Cursor* c, HbcDeltaField* out) {
  if (!Consume(c, '[')) {
    return false;
  }
  if (!ParseUInt(c, &out->byte) || !Consume(c, ',') ||
      !ParseUInt(c, &out->bit) || !Consume(c, ',') ||
      !ParseUInt(c, &out->bits)) {
    return false;
  }
  // 语义范围在解析层就拒绝(与 TransformHbcInPlace 的校验双保险):
  // 位域必须落在一个 32 位字内,bit>31 的值没有任何合法用途。
  if (out->bits < 1 || out->bits > 32 || out->bit > 31 ||
      out->bit + out->bits > 32) {
    return false;
  }
  return Consume(c, ']');
}

// [countIndex, entrySize, [field, ...]]
bool ParseSection(Cursor* c, HbcTransformMeta::Section* out) {
  if (!Consume(c, '[')) {
    return false;
  }
  if (!ParseUInt(c, &out->countIndex) || !Consume(c, ',') ||
      !ParseUInt(c, &out->entrySize) || !Consume(c, ',')) {
    return false;
  }
  if (!Consume(c, '[')) {
    return false;
  }
  if (!Consume(c, ']')) {
    while (true) {
      HbcDeltaField field{};
      if (out->deltaFields.size() >= kMaxDeltaFields ||
          !ParseDeltaField(c, &field)) {
        return false;
      }
      out->deltaFields.push_back(field);
      if (Consume(c, ']')) {
        break;
      }
      if (!Consume(c, ',')) {
        return false;
      }
    }
  }
  return Consume(c, ']');
}

bool ParseLayout(Cursor* c, HbcTransformMeta* out) {
  if (!Consume(c, '{')) {
    return false;
  }
  bool sawCounts = false;
  bool sawSections = false;
  if (!Consume(c, '}')) {
    while (true) {
      std::string key;
      if (!ParseKey(c, &key) || !Consume(c, ':')) {
        return false;
      }
      if (key == "counts") {
        if (!ParseUInt(c, &out->headerCountFields)) {
          return false;
        }
        sawCounts = true;
      } else if (key == "sections") {
        if (!Consume(c, '[')) {
          return false;
        }
        if (!Consume(c, ']')) {
          while (true) {
            HbcTransformMeta::Section section;
            if (out->sections.size() >= kMaxSections ||
                !ParseSection(c, &section)) {
              return false;
            }
            out->sections.push_back(std::move(section));
            if (Consume(c, ']')) {
              break;
            }
            if (!Consume(c, ',')) {
              return false;
            }
          }
        }
        sawSections = true;
      } else if (!SkipValue(c, 0)) {
        return false;
      }
      if (Consume(c, '}')) {
        break;
      }
      if (!Consume(c, ',')) {
        return false;
      }
    }
  }
  return sawCounts && sawSections;
}

} // namespace

bool ParseHbcTransformMeta(const std::string& json, HbcTransformMeta* out) {
  if (out == nullptr || json.empty() || json.size() > kMaxInputBytes) {
    return false;
  }
  *out = HbcTransformMeta{};
  Cursor c{json.data(), json.data() + json.size()};

  if (!Consume(&c, '{')) {
    return false;
  }
  bool sawV = false;
  bool sawHbcVersion = false;
  bool sawLayout = false;
  if (!Consume(&c, '}')) {
    while (true) {
      std::string key;
      if (!ParseKey(&c, &key) || !Consume(&c, ':')) {
        return false;
      }
      if (key == "v") {
        if (!ParseUInt(&c, &out->v)) {
          return false;
        }
        sawV = true;
      } else if (key == "hbcVersion") {
        if (!ParseUInt(&c, &out->hbcVersion)) {
          return false;
        }
        sawHbcVersion = true;
      } else if (key == "layout") {
        if (!Peek(&c, '{') || !ParseLayout(&c, out)) {
          return false;
        }
        sawLayout = true;
      } else if (!SkipValue(&c, 0)) {
        return false;
      }
      if (Consume(&c, '}')) {
        break;
      }
      if (!Consume(&c, ',')) {
        return false;
      }
    }
  }
  SkipWs(&c);
  if (c.p != c.end) {
    return false; // 尾部不允许有多余内容
  }
  if (!sawV || !sawHbcVersion || !sawLayout) {
    return false;
  }
  if (out->sections.empty() || out->headerCountFields == 0) {
    return false;
  }
  return true;
}

HbcLayoutDesc BuildLayout(
    const HbcTransformMeta& meta,
    std::vector<HbcSectionDesc>* sections_scratch) {
  sections_scratch->clear();
  sections_scratch->reserve(meta.sections.size());
  for (const HbcTransformMeta::Section& s : meta.sections) {
    HbcSectionDesc desc;
    desc.countIndex = s.countIndex;
    desc.entrySize = s.entrySize;
    desc.deltaFields = s.deltaFields.empty() ? nullptr : s.deltaFields.data();
    desc.deltaFieldCount = static_cast<uint32_t>(s.deltaFields.size());
    sections_scratch->push_back(desc);
  }
  HbcLayoutDesc layout;
  layout.headerCountFields = meta.headerCountFields;
  layout.sections = sections_scratch->data();
  layout.sectionCount = static_cast<uint32_t>(sections_scratch->size());
  return layout;
}

} // namespace hbc
} // namespace pushy
