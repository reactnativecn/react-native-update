// libFuzzer harness for the hbcTransform wire parser (untrusted __diff.json
// metadata) and the byte-level transform it drives. Build and run with
//   FUZZ=1 ./scripts/test-patch-core.sh
// (clang -fsanitize=fuzzer,address,undefined). Any crash or sanitizer report
// is a finding.
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../hbc_transform.h"
#include "../hbc_transform_wire.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string json(reinterpret_cast<const char*>(data), size);
  pushy::hbc::HbcTransformMeta meta;
  if (!pushy::hbc::ParseHbcTransformMeta(json, &meta)) {
    return 0;
  }
  std::vector<pushy::hbc::HbcSectionDesc> scratch;
  const pushy::hbc::HbcLayoutDesc layout = pushy::hbc::BuildLayout(meta, &scratch);
  // Drive the accepted layout over the same bytes: the transform must stay
  // in bounds for any (layout, buffer) pair, not only for real bundles.
  std::vector<uint8_t> buffer(data, data + size);
  if (pushy::hbc::TransformHbcInPlace(buffer.data(), buffer.size(), layout, false)) {
    pushy::hbc::TransformHbcInPlace(buffer.data(), buffer.size(), layout, true);
  }
  return 0;
}
