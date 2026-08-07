#pragma once

#include <cstdint>
#include <string>

#include "flow_json.h"

// C++ port of the update-flow decision layer.
//
// src/updateFlowCore.ts is the REFERENCE implementation: every function here
// mirrors its TS counterpart 1:1, including object key order and JS
// truthiness/strict-equality semantics, because parity is enforced by golden
// vectors (tests/flow_vectors.json, generated from the TS side). Any semantic
// change lands in the TS file first, regenerates the vectors, then gets
// ported here — never the other direction.
//
// Like the TS side this layer is pure: no IO, no time, no randomness — the
// random sample, identity and parsed JSON all arrive as parameters. The
// orchestrators (per-platform HTTP/download/state glue) own all effects.
namespace updateflow {

uint32_t Murmur3_32(const std::string& key, uint32_t seed = 0);

// murmur(uuid) % 100 < rollout — the gray-release bucketing predicate.
bool IsInRollout(double rollout, const std::string& uuid);

// paths × fileName -> candidate URL array; Undefined when fileName is falsy
// (mirrors joinUrls returning undefined without a file name).
flowjson::Value JoinUrls(const flowjson::Value& paths,
                         const flowjson::Value& fileName);

// Dedupe + move the sampled pick to the front, rest in configured order.
// randomSample ∈ [0, 1) is injected by the caller.
flowjson::Value OrderEndpointCandidates(const flowjson::Value& endpoints,
                                        double randomSample);

// input: { packageVersion, currentVersion, buildTime, cInfo,
//          supportedDiffVersion?, bundleHash?, isDev?, extra? }
flowjson::Value BuildCheckRequestBody(const flowjson::Value& input);

// identity: { packageVersion, currentVersion?, uuid }
flowjson::Value ResolveCheckResult(const flowjson::Value& rootInfo,
                                   const flowjson::Value& identity);

// identity: { currentVersion?, rolledBackVersion? }
// -> { action: 'none', reason } | { action: 'download', hash, attempts,
//      devNoop }
flowjson::Value DecideDownload(const flowjson::Value& info,
                               const flowjson::Value& identity, bool isDev);

// Composes Parse → ResolveCheckResult → DecideDownload: one call from the
// raw checkUpdate response text to a download decision, so the platform
// orchestrators contain no decision logic at all. identity is the union of
// both composed functions' needs: { packageVersion, currentVersion?, uuid,
// rolledBackVersion? }. The decision additionally carries `info` — the
// resolved check result — so orchestrators can persist name/description/
// metaInfo alongside a downloaded version (the JS side's setLocalHashInfo).
// Malformed JSON yields { action: 'none', reason: 'invalidResponse' }.
flowjson::Value HandleCheckResponse(const std::string& responseText,
                                    const flowjson::Value& identity,
                                    bool isDev);

}  // namespace updateflow
