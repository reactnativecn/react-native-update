#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/patch-core-tests"

mkdir -p "$BUILD_DIR"

# Opt-in AddressSanitizer + UndefinedBehaviorSanitizer build. The patch core
# processes untrusted (downloaded) patch data, so running the tests under
# sanitizers catches memory/UB regressions. Enable with: SANITIZE=1 npm run test:patch-core
SANITIZE_FLAGS=""
if [ "${SANITIZE:-0}" = "1" ]; then
  SANITIZE_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer -g"
  echo "Building patch core tests with AddressSanitizer + UBSan"
fi

# The cpp/ cores must build warning-free (-Werror); the vendored HDiffPatch /
# lzma C sources are compiled with -Wall -Wextra only.
CORE_WARNINGS="-Wall -Wextra -Werror"

COMMON_INCLUDES="
  -I$ROOT_DIR/cpp/patch_core
  -I$ROOT_DIR/android/jni
  -I$ROOT_DIR/android/jni/HDiffPatch
  -I$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch
  -I$ROOT_DIR/android/jni/lzma/C
"

cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/hpatch.c" -o "$BUILD_DIR/hpatch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch/patch.c" -o "$BUILD_DIR/patch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/file_for_patch.c" -o "$BUILD_DIR/file_for_patch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/LzmaDec.c" -o "$BUILD_DIR/LzmaDec.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/Lzma2Dec.c" -o "$BUILD_DIR/Lzma2Dec.o"

c++ \
  -std=c++17 \
  $CORE_WARNINGS \
  $SANITIZE_FLAGS \
  $COMMON_INCLUDES \
  "$ROOT_DIR/cpp/patch_core/tests/patch_core_test.cpp" \
  "$ROOT_DIR/cpp/patch_core/archive_patch_core.cpp" \
  "$ROOT_DIR/cpp/patch_core/digest.cpp" \
  "$ROOT_DIR/cpp/patch_core/patch_core.cpp" \
  "$ROOT_DIR/cpp/patch_core/state_core.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform_wire.cpp" \
  "$BUILD_DIR/hpatch.o" \
  "$BUILD_DIR/patch.o" \
  "$BUILD_DIR/file_for_patch.o" \
  "$BUILD_DIR/LzmaDec.o" \
  "$BUILD_DIR/Lzma2Dec.o" \
  -o "$BUILD_DIR/patch_core_test"

c++ \
  -std=c++17 \
  $CORE_WARNINGS \
  $SANITIZE_FLAGS \
  "$ROOT_DIR/cpp/patch_core/tests/hbc_transform_test.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform_wire.cpp" \
  -o "$BUILD_DIR/hbc_transform_test"

"$BUILD_DIR/patch_core_test" "$ROOT_DIR/cpp/patch_core/tests/fixtures"
"$BUILD_DIR/hbc_transform_test" "$ROOT_DIR/cpp/patch_core/tests/fixtures"

# Opt-in libFuzzer run of the hbcTransform wire parser (untrusted __diff.json
# metadata): FUZZ=1 npm run test:patch-core. Needs clang with the libFuzzer
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
    echo "Fuzzing hbcTransform wire parser for ${FUZZ_SECONDS:-20}s"
    clang++ \
      -std=c++17 \
      $CORE_WARNINGS \
      -g -O1 -fno-omit-frame-pointer \
      -fsanitize=fuzzer,address,undefined \
      "$ROOT_DIR/cpp/patch_core/tests/fuzz_hbc_transform_wire.cpp" \
      "$ROOT_DIR/cpp/patch_core/hbc_transform.cpp" \
      "$ROOT_DIR/cpp/patch_core/hbc_transform_wire.cpp" \
      -o "$BUILD_DIR/fuzz_hbc_transform_wire"
    CORPUS_DIR="$BUILD_DIR/fuzz-corpus-hbc-transform-wire"
    mkdir -p "$CORPUS_DIR"
    cp "$ROOT_DIR/cpp/patch_core/tests/fixtures/v96.meta.json" "$CORPUS_DIR/seed-v96-meta.json"
    "$BUILD_DIR/fuzz_hbc_transform_wire" \
      -max_total_time="${FUZZ_SECONDS:-20}" \
      -max_len=8192 \
      -print_final_stats=1 \
      "$CORPUS_DIR"
  fi
fi
