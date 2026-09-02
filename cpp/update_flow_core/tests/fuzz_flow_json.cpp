// libFuzzer harness for the JSON parser and the decision pipeline built on it
// — both consume raw server bytes. Build and run with
//   FUZZ=1 ./scripts/test-update-flow-core.sh
// (clang -fsanitize=fuzzer,address,undefined). Any crash, sanitizer report or
// abort() below is a finding.
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <string>

#include "../flow_json.h"
#include "../update_flow_core.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string text(reinterpret_cast<const char*>(data), size);

  bool ok = false;
  const flowjson::Value parsed = flowjson::Parse(text, &ok);
  if (ok) {
    // Whatever parses must stringify to something that parses again: the
    // canonical serialization is what every vector comparison relies on.
    bool ok_again = false;
    flowjson::Parse(flowjson::Stringify(parsed), &ok_again);
    if (!ok_again) {
      std::abort();
    }
  }

  flowjson::Value identity = flowjson::Value::Object();
  identity.Set("packageVersion", flowjson::Value::String("2.3.4"));
  identity.Set("currentVersion", flowjson::Value::String("cur"));
  identity.Set("uuid", flowjson::Value::String("test1"));
  identity.Set("rolledBackVersion", flowjson::Value::String("bad"));
  flowjson::Stringify(
      updateflow::HandleCheckResponse(text, identity, false, "none"));
  updateflow::IsValidCheckResponse(text);
  return 0;
}
