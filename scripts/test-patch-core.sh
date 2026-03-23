#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/patch-core-tests"

mkdir -p "$BUILD_DIR"

COMMON_INCLUDES="
  -I$ROOT_DIR/cpp/patch_core
  -I$ROOT_DIR/android/jni
  -I$ROOT_DIR/android/jni/HDiffPatch
  -I$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch
  -I$ROOT_DIR/android/jni/lzma/C
"

cc -Wall -Wextra $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/hpatch.c" -o "$BUILD_DIR/hpatch.o"
cc -Wall -Wextra $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch/patch.c" -o "$BUILD_DIR/patch.o"
cc -Wall -Wextra $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/file_for_patch.c" -o "$BUILD_DIR/file_for_patch.o"
cc -Wall -Wextra $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/LzmaDec.c" -o "$BUILD_DIR/LzmaDec.o"
cc -Wall -Wextra $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/Lzma2Dec.c" -o "$BUILD_DIR/Lzma2Dec.o"

c++ \
  -std=c++17 \
  -Wall \
  -Wextra \
  $COMMON_INCLUDES \
  "$ROOT_DIR/cpp/patch_core/tests/patch_core_test.cpp" \
  "$ROOT_DIR/cpp/patch_core/patch_core.cpp" \
  "$BUILD_DIR/hpatch.o" \
  "$BUILD_DIR/patch.o" \
  "$BUILD_DIR/file_for_patch.o" \
  "$BUILD_DIR/LzmaDec.o" \
  "$BUILD_DIR/Lzma2Dec.o" \
  -o "$BUILD_DIR/patch_core_test"

"$BUILD_DIR/patch_core_test"
