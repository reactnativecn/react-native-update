#include "flow_json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace flowjson {

namespace {
const Value kUndefined;
}  // namespace

bool Value::Truthy() const {
  switch (kind_) {
    case Kind::Undefined:
    case Kind::Null:
      return false;
    case Kind::Bool:
      return bool_;
    case Kind::Number:
      return number_ != 0 && !std::isnan(number_);
    case Kind::String:
      return !string_.empty();
    case Kind::Array:
    case Kind::Object:
      return true;
  }
  return false;
}

const Value& Value::At(size_t i) const {
  if (kind_ != Kind::Array || i >= elements_.size()) {
    return kUndefined;
  }
  return elements_[i];
}

const Value& Value::Get(const std::string& key) const {
  if (kind_ == Kind::Object) {
    for (const auto& member : members_) {
      if (member.first == key) {
        return member.second;
      }
    }
  }
  return kUndefined;
}

void Value::Set(const std::string& key, Value v) {
  for (auto& member : members_) {
    if (member.first == key) {
      member.second = std::move(v);
      return;
    }
  }
  members_.emplace_back(key, std::move(v));
}

void Value::Remove(const std::string& key) {
  for (auto it = members_.begin(); it != members_.end(); ++it) {
    if (it->first == key) {
      members_.erase(it);
      return;
    }
  }
}

bool Value::StrictEquals(const Value& a, const Value& b) {
  if (a.kind_ != b.kind_) {
    return false;
  }
  switch (a.kind_) {
    case Kind::Undefined:
    case Kind::Null:
      return true;
    case Kind::Bool:
      return a.bool_ == b.bool_;
    case Kind::Number:
      return a.number_ == b.number_;
    case Kind::String:
      return a.string_ == b.string_;
    case Kind::Array:
    case Kind::Object:
      return false;
  }
  return false;
}

namespace {

void AppendEscaped(const std::string& s, std::string* out) {
  out->push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out->append("\\\"");
        break;
      case '\\':
        out->append("\\\\");
        break;
      case '\b':
        out->append("\\b");
        break;
      case '\f':
        out->append("\\f");
        break;
      case '\n':
        out->append("\\n");
        break;
      case '\r':
        out->append("\\r");
        break;
      case '\t':
        out->append("\\t");
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out->append(buf);
        } else {
          out->push_back(static_cast<char>(c));
        }
    }
  }
  out->push_back('"');
}

void AppendNumber(double n, std::string* out) {
  // The decision layer only ever emits integral numbers (hashes, counters,
  // rollout percentages); print them the way JSON.stringify does. The %.17g
  // fallback exists so an unexpected fractional value surfaces as a vector
  // mismatch instead of silent truncation.
  if (std::isfinite(n) && n == std::floor(n) && std::fabs(n) <= 9007199254740992.0) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(n));
    out->append(buf);
  } else {
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.17g", n);
    out->append(buf);
  }
}

void AppendValue(const Value& v, std::string* out) {
  switch (v.kind()) {
    case Value::Kind::Undefined:  // only reachable inside arrays
    case Value::Kind::Null:
      out->append("null");
      break;
    case Value::Kind::Bool:
      out->append(v.AsBool() ? "true" : "false");
      break;
    case Value::Kind::Number:
      AppendNumber(v.AsNumber(), out);
      break;
    case Value::Kind::String:
      AppendEscaped(v.AsString(), out);
      break;
    case Value::Kind::Array: {
      out->push_back('[');
      bool first = true;
      for (const auto& element : v.elements()) {
        if (!first) {
          out->push_back(',');
        }
        first = false;
        AppendValue(element, out);
      }
      out->push_back(']');
      break;
    }
    case Value::Kind::Object: {
      out->push_back('{');
      bool first = true;
      for (const auto& member : v.members()) {
        if (member.second.IsUndefined()) {
          continue;  // JSON.stringify drops undefined-valued members
        }
        if (!first) {
          out->push_back(',');
        }
        first = false;
        AppendEscaped(member.first, out);
        out->push_back(':');
        AppendValue(member.second, out);
      }
      out->push_back('}');
      break;
    }
  }
}

}  // namespace

std::string Stringify(const Value& v) {
  if (v.IsUndefined()) {
    return "undefined";
  }
  std::string out;
  AppendValue(v, &out);
  return out;
}

namespace {

// The parser also consumes server checkUpdate responses, so hostile input
// must fail cleanly: nesting is capped to keep recursive descent off the
// stack limit. Real responses nest ~4 levels.
constexpr int kMaxDepth = 64;

class Parser {
 public:
  Parser(const std::string& text) : text_(text) {}

  Value Run(bool* ok) {
    Value v = ParseValue();
    SkipWs();
    *ok = ok_ && pos_ == text_.size();
    return *ok ? v : Value::Undefined();
  }

 private:
  void SkipWs() {
    while (pos_ < text_.size()) {
      char c = text_[pos_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        pos_++;
      } else {
        break;
      }
    }
  }

  bool Consume(char expected) {
    if (pos_ < text_.size() && text_[pos_] == expected) {
      pos_++;
      return true;
    }
    ok_ = false;
    return false;
  }

  bool ConsumeLiteral(const char* literal) {
    size_t len = 0;
    while (literal[len]) {
      len++;
    }
    if (text_.compare(pos_, len, literal) == 0) {
      pos_ += len;
      return true;
    }
    ok_ = false;
    return false;
  }

  Value ParseValue() {
    SkipWs();
    if (pos_ >= text_.size()) {
      ok_ = false;
      return Value::Undefined();
    }
    char c = text_[pos_];
    switch (c) {
      case '{':
      case '[': {
        if (depth_ >= kMaxDepth) {
          ok_ = false;
          return Value::Undefined();
        }
        depth_++;
        Value v = c == '{' ? ParseObject() : ParseArray();
        depth_--;
        return v;
      }
      case '"':
        return Value::String(ParseString());
      case 't':
        ConsumeLiteral("true");
        return Value::Bool(true);
      case 'f':
        ConsumeLiteral("false");
        return Value::Bool(false);
      case 'n':
        ConsumeLiteral("null");
        return Value::Null();
      default:
        return ParseNumber();
    }
  }

  Value ParseObject() {
    Value obj = Value::Object();
    Consume('{');
    SkipWs();
    if (pos_ < text_.size() && text_[pos_] == '}') {
      pos_++;
      return obj;
    }
    while (ok_) {
      SkipWs();
      std::string key = ParseString();
      SkipWs();
      Consume(':');
      obj.Set(key, ParseValue());
      SkipWs();
      if (pos_ < text_.size() && text_[pos_] == ',') {
        pos_++;
        continue;
      }
      Consume('}');
      break;
    }
    return obj;
  }

  Value ParseArray() {
    Value arr = Value::Array();
    Consume('[');
    SkipWs();
    if (pos_ < text_.size() && text_[pos_] == ']') {
      pos_++;
      return arr;
    }
    while (ok_) {
      arr.Push(ParseValue());
      SkipWs();
      if (pos_ < text_.size() && text_[pos_] == ',') {
        pos_++;
        continue;
      }
      Consume(']');
      break;
    }
    return arr;
  }

  std::string ParseString() {
    std::string out;
    if (!Consume('"')) {
      return out;
    }
    while (pos_ < text_.size()) {
      char c = text_[pos_++];
      if (c == '"') {
        return out;
      }
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (pos_ >= text_.size()) {
        break;
      }
      char esc = text_[pos_++];
      switch (esc) {
        case '"':
        case '\\':
        case '/':
          out.push_back(esc);
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        case 'u': {
          unsigned code = ParseHex4();
          // BMP code point to UTF-8 (surrogate pairs are combined).
          if (code >= 0xd800 && code <= 0xdbff &&
              text_.compare(pos_, 2, "\\u") == 0) {
            pos_ += 2;
            unsigned low = ParseHex4();
            if (low >= 0xdc00 && low <= 0xdfff) {
              code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
            } else {
              ok_ = false;
            }
          }
          AppendUtf8(code, &out);
          break;
        }
        default:
          ok_ = false;
          return out;
      }
    }
    ok_ = false;
    return out;
  }

  unsigned ParseHex4() {
    unsigned code = 0;
    for (int i = 0; i < 4; i++) {
      if (pos_ >= text_.size()) {
        ok_ = false;
        return 0;
      }
      char c = text_[pos_++];
      code <<= 4;
      if (c >= '0' && c <= '9') {
        code |= static_cast<unsigned>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        code |= static_cast<unsigned>(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        code |= static_cast<unsigned>(c - 'A' + 10);
      } else {
        ok_ = false;
        return 0;
      }
    }
    return code;
  }

  static void AppendUtf8(unsigned code, std::string* out) {
    if (code < 0x80) {
      out->push_back(static_cast<char>(code));
    } else if (code < 0x800) {
      out->push_back(static_cast<char>(0xc0 | (code >> 6)));
      out->push_back(static_cast<char>(0x80 | (code & 0x3f)));
    } else if (code < 0x10000) {
      out->push_back(static_cast<char>(0xe0 | (code >> 12)));
      out->push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3f)));
      out->push_back(static_cast<char>(0x80 | (code & 0x3f)));
    } else {
      out->push_back(static_cast<char>(0xf0 | (code >> 18)));
      out->push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3f)));
      out->push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3f)));
      out->push_back(static_cast<char>(0x80 | (code & 0x3f)));
    }
  }

  Value ParseNumber() {
    size_t start = pos_;
    if (pos_ < text_.size() && text_[pos_] == '-') {
      pos_++;
    }
    while (pos_ < text_.size()) {
      char c = text_[pos_];
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' ||
          c == '+' || c == '-') {
        pos_++;
      } else {
        break;
      }
    }
    if (pos_ == start) {
      ok_ = false;
      return Value::Undefined();
    }
    char* end = nullptr;
    std::string token = text_.substr(start, pos_ - start);
    double n = std::strtod(token.c_str(), &end);
    if (end == nullptr || *end != '\0') {
      ok_ = false;
      return Value::Undefined();
    }
    return Value::Number(n);
  }

  const std::string& text_;
  size_t pos_ = 0;
  int depth_ = 0;
  bool ok_ = true;
};

}  // namespace

Value Parse(const std::string& text, bool* ok) {
  Parser parser(text);
  return parser.Run(ok);
}

}  // namespace flowjson
