#include "update_flow_core.h"

#include <cmath>

namespace updateflow {

using flowjson::Value;

uint32_t Murmur3_32(const std::string& key, uint32_t seed) {
  // The TS reference emulates 32-bit multiplication with 16-bit halves;
  // native uint32_t arithmetic is exactly (x * y) mod 2^32, so the halved
  // dance collapses to plain multiplies. Bytes are read as charCodeAt & 0xff,
  // which is identical for the ASCII inputs this layer handles (uuids, keys).
  const uint32_t c1 = 0xcc9e2d51;
  const uint32_t c2 = 0x1b873593;
  const size_t len = key.size();
  const size_t nblocks = len / 4;
  uint32_t h1 = seed;

  const unsigned char* data =
      reinterpret_cast<const unsigned char*>(key.data());
  for (size_t i = 0; i < nblocks; i++) {
    uint32_t k1 = static_cast<uint32_t>(data[i * 4]) |
                  (static_cast<uint32_t>(data[i * 4 + 1]) << 8) |
                  (static_cast<uint32_t>(data[i * 4 + 2]) << 16) |
                  (static_cast<uint32_t>(data[i * 4 + 3]) << 24);
    k1 *= c1;
    k1 = (k1 << 15) | (k1 >> 17);
    k1 *= c2;
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >> 19);
    h1 = h1 * 5 + 0xe6546b64;
  }

  uint32_t k1 = 0;
  const unsigned char* tail = data + nblocks * 4;
  switch (len & 3) {
    case 3:
      k1 ^= static_cast<uint32_t>(tail[2]) << 16;
      [[fallthrough]];
    case 2:
      k1 ^= static_cast<uint32_t>(tail[1]) << 8;
      [[fallthrough]];
    case 1:
      k1 ^= tail[0];
      k1 *= c1;
      k1 = (k1 << 15) | (k1 >> 17);
      k1 *= c2;
      h1 ^= k1;
  }

  h1 ^= static_cast<uint32_t>(len);
  h1 ^= h1 >> 16;
  h1 *= 0x85ebca6b;
  h1 ^= h1 >> 13;
  h1 *= 0xc2b2ae35;
  h1 ^= h1 >> 16;
  return h1;
}

bool IsInRollout(double rollout, const std::string& uuid) {
  return static_cast<double>(Murmur3_32(uuid) % 100) < rollout;
}

namespace {

// ^[a-z][a-z0-9+.-]*:\/\/ (case-insensitive)
bool HasExplicitScheme(const std::string& s) {
  size_t i = 0;
  auto isAlpha = [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  };
  if (i >= s.size() || !isAlpha(s[i])) {
    return false;
  }
  i++;
  while (i < s.size()) {
    char c = s[i];
    if (isAlpha(c) || (c >= '0' && c <= '9') || c == '+' || c == '.' ||
        c == '-') {
      i++;
    } else {
      break;
    }
  }
  return s.compare(i, 3, "://") == 0;
}

}  // namespace

Value JoinUrls(const Value& paths, const Value& fileName) {
  if (!fileName.Truthy()) {
    return Value::Undefined();
  }
  Value urls = Value::Array();
  for (const auto& path : paths.elements()) {
    std::string normalized = path.AsString();
    while (!normalized.empty() && normalized.back() == '/') {
      normalized.pop_back();
    }
    std::string base = HasExplicitScheme(normalized)
                           ? normalized
                           : "https://" + normalized;
    urls.Push(Value::String(base + "/" + fileName.AsString()));
  }
  return urls;
}

Value OrderEndpointCandidates(const Value& endpoints, double randomSample) {
  Value deduped = Value::Array();
  for (const auto& endpoint : endpoints.elements()) {
    if (!endpoint.Truthy()) {
      continue;
    }
    bool seen = false;
    for (const auto& kept : deduped.elements()) {
      if (kept.AsString() == endpoint.AsString()) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      deduped.Push(endpoint);
    }
  }
  const size_t n = deduped.Size();
  if (n < 2) {
    return deduped;
  }
  const double idx = std::isfinite(randomSample)
                         ? std::floor(randomSample * static_cast<double>(n))
                         : 0;
  // Validate in floating-point space before converting to size_t: converting
  // NaN, infinity, or an out-of-range value is undefined behavior in C++.
  const size_t first = idx <= 0 ? 0
                                : (idx >= static_cast<double>(n - 1)
                                       ? n - 1
                                       : static_cast<size_t>(idx));
  Value ordered = Value::Array();
  ordered.Push(deduped.At(first));
  for (size_t i = 0; i < n; i++) {
    if (i != first) {
      ordered.Push(deduped.At(i));
    }
  }
  return ordered;
}

Value BuildCheckRequestBody(const Value& input) {
  Value body = Value::Object();
  body.Set("packageVersion", input.Get("packageVersion"));
  body.Set("hash", input.Get("currentVersion"));
  body.Set("buildTime", input.Get("buildTime"));
  body.Set("cInfo", input.Get("cInfo"));
  const Value& diffV = input.Get("supportedDiffVersion");
  if (diffV.Truthy()) {
    body.Set("diffV", diffV);
  }
  const Value& bundleHash = input.Get("bundleHash");
  if (bundleHash.Truthy()) {
    body.Set("bundleHash", bundleHash);
  }
  const Value& extra = input.Get("extra");
  if (extra.IsObject()) {
    for (const auto& member : extra.members()) {
      body.Set(member.first, member.second);
    }
  }
  if (input.Get("isDev").Truthy()) {
    body.Remove("buildTime");
  }
  return body;
}

Value ResolveCheckResult(const Value& rootInfo, const Value& identity) {
  Value rootResult = Value::Object();
  for (const auto& member : rootInfo.members()) {
    if (member.first != "expVersion") {
      rootResult.Set(member.first, member.second);
    }
  }
  const Value& expVersion = rootInfo.Get("expVersion");
  const Value& currentVersion = identity.Get("currentVersion");
  // expVersion?.config?.rollout?.[identity.packageVersion] — Get on a
  // non-object returns Undefined, mirroring optional chaining.
  const Value& rollout = expVersion.Get("config").Get("rollout").Get(
      identity.Get("packageVersion").AsString());
  if (rootResult.Get("update").Truthy() && expVersion.Truthy() &&
      rollout.IsNumber()) {
    if (IsInRollout(rollout.AsNumber(), identity.Get("uuid").AsString())) {
      const Value& expHash = expVersion.Get("hash");
      if (expHash.IsString() && !expHash.AsString().empty() &&
          Value::StrictEquals(expHash, currentVersion)) {
        Value upToDate = Value::Object();
        upToDate.Set("upToDate", Value::Bool(true));
        return upToDate;
      }
      Value info = Value::Object();
      info.Set("update", Value::Bool(true));
      for (const auto& member : expVersion.members()) {
        info.Set(member.first, member.second);
      }
      if (rootResult.Get("paths").Truthy()) {
        info.Set("paths", rootResult.Get("paths"));
      }
      return info;
    }
  }
  const Value& rootHash = rootResult.Get("hash");
  if (rootResult.Get("update").Truthy() && rootHash.IsString() &&
      !rootHash.AsString().empty() &&
      Value::StrictEquals(rootHash, currentVersion)) {
    Value upToDate = Value::Object();
    upToDate.Set("upToDate", Value::Bool(true));
    return upToDate;
  }
  return rootResult;
}

namespace {

Value DeclineDownload(const char* reason) {
  Value none = Value::Object();
  none.Set("action", Value::String("none"));
  none.Set("reason", Value::String(reason));
  return none;
}

}  // namespace

Value DecideDownload(const Value& info, const Value& identity, bool isDev) {
  const Value& hash = info.Get("hash");
  Value paths = info.Get("paths");
  if (paths.IsUndefined()) {
    paths = Value::Array();  // const { paths = [] } — undefined only
  }
  if (!info.Get("update").Truthy() || !hash.Truthy()) {
    return DeclineDownload("noUpdate");
  }
  if (Value::StrictEquals(hash, identity.Get("currentVersion"))) {
    return DeclineDownload("alreadyCurrent");
  }
  const Value& rolledBack = identity.Get("rolledBackVersion");
  if (rolledBack.Truthy() && Value::StrictEquals(hash, rolledBack)) {
    return DeclineDownload("rolledBack");
  }
  Value attempts = Value::Array();
  auto pushAttempt = [&attempts](const char* type, const Value& urls) {
    if (urls.IsArray() && urls.Size() > 0) {
      Value attempt = Value::Object();
      attempt.Set("type", Value::String(type));
      attempt.Set("urls", urls);
      attempts.Push(std::move(attempt));
    }
  };
  if (!isDev) {
    pushAttempt("diff", JoinUrls(paths, info.Get("diff")));
    pushAttempt("pdiff", JoinUrls(paths, info.Get("pdiff")));
  }
  Value fullUrls = JoinUrls(paths, info.Get("full"));
  pushAttempt("full", fullUrls);

  const bool devNoop =
      isDev && !(fullUrls.IsArray() && fullUrls.Size() > 0);
  if (attempts.Size() == 0 && !devNoop) {
    return DeclineDownload("noArtifact");
  }

  Value decision = Value::Object();
  decision.Set("action", Value::String("download"));
  decision.Set("hash", hash);
  decision.Set("attempts", std::move(attempts));
  decision.Set("devNoop", Value::Bool(devNoop));
  return decision;
}

bool ShouldActivateAfterDownload(const Value& info,
                                 const std::string& afterDownload) {
  return afterDownload == "setNeedUpdate" ||
         info.Get("config").Get("forceBoot").Truthy();
}

Value HandleCheckResponse(const std::string& responseText,
                          const Value& identity, bool isDev,
                          const std::string& afterDownload) {
  bool ok = false;
  Value root = flowjson::Parse(responseText, &ok);
  if (!ok || !root.IsObject()) {
    return DeclineDownload("invalidResponse");
  }
  Value resolved = ResolveCheckResult(root, identity);
  Value decision = DecideDownload(resolved, identity, isDev);
  if (decision.Get("action").AsString() == "download") {
    decision.Set("activate", Value::Bool(ShouldActivateAfterDownload(
                                 resolved, afterDownload)));
  }
  decision.Set("info", std::move(resolved));
  return decision;
}

}  // namespace updateflow
