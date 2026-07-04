#!/usr/bin/env bash
#
# Verify the prebuilt Android native libraries shipped in android/lib/ are
# present for every ABI and export the JNI symbols the Java layer binds. This
# guards against publishing an npm package whose committed librnupdate.so is
# stale/missing after a cpp/patch_core change (which would crash consumers at
# runtime with UnsatisfiedLinkError while CI stays green).
#
# Usage: scripts/verify-android-so.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR="$ROOT_DIR/android/lib"

ABIS=(arm64-v8a armeabi-v7a x86 x86_64)

# JNI entry points the Java `native` declarations bind to. Keep in sync with
# the native methods in android/src/main/java/cn/reactnative/modules/update/.
REQUIRED_SYMBOLS=(
  Java_cn_reactnative_modules_update_DownloadTask_applyPatchFromFileSource
  Java_cn_reactnative_modules_update_DownloadTask_cleanupOldEntries
  Java_cn_reactnative_modules_update_DownloadTask_buildArchivePatchPlan
  Java_cn_reactnative_modules_update_DownloadTask_buildCopyGroups
  Java_cn_reactnative_modules_update_UpdateContext_syncStateWithBinaryVersion
  Java_cn_reactnative_modules_update_UpdateContext_runStateCore
)

# Prefer llvm-nm (handles all target ABIs), fall back to nm.
NM_BIN="$(command -v llvm-nm || command -v nm || true)"
if [ -z "$NM_BIN" ]; then
  echo "error: neither llvm-nm nor nm found on PATH" >&2
  exit 1
fi

fail=0
for abi in "${ABIS[@]}"; do
  so="$LIB_DIR/$abi/librnupdate.so"
  if [ ! -s "$so" ]; then
    echo "error: missing or empty native library: $so" >&2
    fail=1
    continue
  fi
  symbols="$("$NM_BIN" -D "$so" 2>/dev/null || "$NM_BIN" "$so" 2>/dev/null || true)"
  for sym in "${REQUIRED_SYMBOLS[@]}"; do
    if ! grep -q "$sym" <<<"$symbols"; then
      echo "error: $so does not export $sym (stale .so? rebuild with 'npm run build:so')" >&2
      fail=1
    fi
  done
  if [ "$fail" -eq 0 ]; then
    echo "ok: $abi librnupdate.so exports all required symbols"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Android native library verification FAILED." >&2
  exit 1
fi
echo "All Android native libraries verified."
