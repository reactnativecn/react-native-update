#!/bin/sh
set -eu

# Intentional one-command CDPATH assignment.
# shellcheck disable=SC1007
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/update-flow-core-tests"

mkdir -p "$BUILD_DIR"

# Opt-in sanitizers, same convention as test-patch-core.sh:
# SANITIZE=1 npm run test:flow-core
SANITIZE_FLAGS=""
if [ "${SANITIZE:-0}" = "1" ]; then
  SANITIZE_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer -g"
  echo "Building update flow core tests with AddressSanitizer + UBSan"
fi

# The cpp/ cores must build warning-free.
CORE_WARNINGS="-Wall -Wextra -Werror"

# SANITIZE_FLAGS must split into compiler arguments.
# shellcheck disable=SC2086
c++ \
  -std=c++17 \
  $CORE_WARNINGS \
  $SANITIZE_FLAGS \
  "$ROOT_DIR/cpp/update_flow_core/flow_json.cpp" \
  "$ROOT_DIR/cpp/update_flow_core/update_flow_core.cpp" \
  "$ROOT_DIR/cpp/update_flow_core/tests/update_flow_core_test.cpp" \
  -o "$BUILD_DIR/update_flow_core_test"

"$BUILD_DIR/update_flow_core_test" \
  "$ROOT_DIR/cpp/update_flow_core/tests/flow_vectors.json"

# Opt-in libFuzzer run of the JSON parser + decision pipeline (raw server
# bytes): FUZZ=1 npm run test:flow-core. Needs clang with the libFuzzer
# runtime (libclang_rt.fuzzer); without it the step is skipped, not failed.
# FUZZ_SECONDS bounds the run (default 20).
if [ "${FUZZ:-0}" = "1" ]; then
  FUZZ_PROBE="$BUILD_DIR/fuzz_probe.cpp"
  printf '#include <cstddef>\n#include <cstdint>\nextern "C" int LLVMFuzzerTestOneInput(const uint8_t*, size_t) { return 0; }\n' > "$FUZZ_PROBE"
  if ! command -v clang++ >/dev/null 2>&1; then
    echo "FUZZ=1: clang++ not found, skipping the libFuzzer run"
  elif ! clang++ -fsanitize=fuzzer,address,undefined "$FUZZ_PROBE" -o "$BUILD_DIR/fuzz_probe" >/dev/null 2>&1; then
    echo "FUZZ=1: clang++ has no libFuzzer runtime (libclang_rt.fuzzer), skipping the libFuzzer run"
  else
    echo "Fuzzing flow JSON parser + decision pipeline for ${FUZZ_SECONDS:-20}s"
    # shellcheck disable=SC2086
    clang++ \
      -std=c++17 \
      $CORE_WARNINGS \
      -g -O1 -fno-omit-frame-pointer \
      -fsanitize=fuzzer,address,undefined \
      "$ROOT_DIR/cpp/update_flow_core/flow_json.cpp" \
      "$ROOT_DIR/cpp/update_flow_core/update_flow_core.cpp" \
      "$ROOT_DIR/cpp/update_flow_core/tests/fuzz_flow_json.cpp" \
      -o "$BUILD_DIR/fuzz_flow_json"
    CORPUS_DIR="$BUILD_DIR/fuzz-corpus-flow-json"
    mkdir -p "$CORPUS_DIR"
    printf '{"update":true,"hash":"h2","full":"h2.ppk","diff":"d.hdiff","paths":["cdn.x.com","https://m.x.com/"],"name":"v2","config":{"forceBoot":true}}' > "$CORPUS_DIR/seed-download.json"
    printf '{"update":true,"hash":"root","expVersion":{"hash":"gray","full":"g.ppk","config":{"rollout":{"2.3.4":63}}},"paths":["cdn"]}' > "$CORPUS_DIR/seed-rollout.json"
    printf '{"upToDate":true,"s":"\\ud83d\\ude00 \\u00e9 \\n","n":[1,-0.5,1e2,null,false]}' > "$CORPUS_DIR/seed-scalars.json"
    "$BUILD_DIR/fuzz_flow_json" \
      -max_total_time="${FUZZ_SECONDS:-20}" \
      -max_len=4096 \
      -print_final_stats=1 \
      "$CORPUS_DIR"
  fi
fi
